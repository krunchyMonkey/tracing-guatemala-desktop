import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { JournalEntry, JournalEntryInput, JournalMutationResult } from '../../src/shared/case-journal'
import type { CaseMutationResult, ResearchCase } from '../../src/shared/case-model'
import { call, send, signIn, writeHeaders, type Signed } from './live-helpers'

// Case research journal calls (#18) over real HTTP on 127.0.0.1 against the Live
// web host, with throwaway data folders. Fictional data only.

const entry: JournalEntryInput = {
  occurredAt: '2026-10-20T15:30:00.000Z',
  activity: 'Archive search',
  body: 'Looked through the 1931 parish index.\nNothing under Ejemplo.'
}

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
  root = mkdtempSync(join(tmpdir(), 'tg-live-journal-test-'))
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
  const created = await call<CaseMutationResult>(live, signed, 'createCase', clientId, {
    title,
    goal: null,
    orderReference: null,
    dueDate: null
  })
  if (!created.ok) throw new Error('createCase failed')
  return created.case
}

const newCase = async (live: RunningLiveServer, signed: Signed, displayName: string, title: string) =>
  newCaseFor(live, signed, await newClient(live, signed, displayName), title)

const post = (live: RunningLiveServer, signed: Signed, name: string, args: unknown[]) =>
  send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, signed), JSON.stringify({ args }))

function created(result: JournalMutationResult): JournalEntry {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.entry
}

describe('case journal calls', () => {
  it('lists, creates and updates entries, newest first, and survives a host restart', async () => {
    let live = await start()
    let signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')

    expect(await call<JournalEntry[]>(live, signed, 'listJournalEntries', researchCase.id)).toEqual([])
    expect(await call<JournalEntry[]>(live, signed, 'listJournalEntries', crypto.randomUUID())).toEqual([])

    const first = created(
      await call(live, signed, 'createJournalEntry', researchCase.id, { occurredAt: '2026-10-20T09:30:00-06:00', activity: '  ', body: '  trimmed\r\nlines  ' })
    )
    expect(first).toMatchObject({ caseId: researchCase.id, occurredAt: '2026-10-20T15:30:00.000Z', activity: null, body: 'trimmed\nlines' })
    const backdated = created(await call(live, signed, 'createJournalEntry', researchCase.id, { ...entry, occurredAt: '2026-09-01T10:00:00.000Z' }))
    const updated = created(await call(live, signed, 'updateJournalEntry', researchCase.id, first.id, { ...entry, body: 'Edited.' }))
    expect(updated).toMatchObject({ id: first.id, body: 'Edited.', createdAt: first.createdAt })

    const listed = await call<JournalEntry[]>(live, signed, 'listJournalEntries', researchCase.id)
    expect(listed.map((e) => e.id)).toEqual([first.id, backdated.id])

    await live.close()
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'listJournalEntries', researchCase.id)).toEqual(listed)
  })

  it('keeps entries of cases apart, including two cases of one client', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed, 'Ana Ejemplo')
    const caseA = await newCaseFor(live, signed, clientId, 'Case A')
    const caseA2 = await newCaseFor(live, signed, clientId, 'Case A2')
    const caseB = await newCase(live, signed, 'Ana Ejemplar', 'Case B')
    const inA = created(await call(live, signed, 'createJournalEntry', caseA.id, { ...entry, body: 'In A' }))
    await call(live, signed, 'createJournalEntry', caseB.id, { ...entry, body: 'In B' })
    expect(await call<JournalEntry[]>(live, signed, 'listJournalEntries', caseA2.id)).toEqual([])
    expect((await call<JournalEntry[]>(live, signed, 'listJournalEntries', caseB.id)).map((e) => e.body)).toEqual(['In B'])
    // The journal is not the client's notes.
    expect(await call<unknown[]>(live, signed, 'listNotes', clientId)).toEqual([])

    // An entry id under the wrong case is not found, and the entry stays as it was.
    expect(await call(live, signed, 'updateJournalEntry', caseB.id, inA.id, { ...entry, body: 'hijack' })).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'updateJournalEntry', caseA2.id, inA.id, { ...entry, body: 'hijack' })).toEqual({ ok: false, reason: 'not-found' })
    expect(await call<JournalEntry[]>(live, signed, 'listJournalEntries', caseA.id)).toEqual([inA])
  })

  it('answers unknown, archived and invalid writes with results, not errors', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const made = created(await call(live, signed, 'createJournalEntry', researchCase.id, entry))

    expect(await call(live, signed, 'createJournalEntry', crypto.randomUUID(), entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'updateJournalEntry', researchCase.id, crypto.randomUUID(), entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'createJournalEntry', researchCase.id, { occurredAt: 'nope', activity: 'a\nb', body: '   ' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'body', code: 'required' },
        { field: 'activity', code: 'invalid-characters' },
        { field: 'occurredAt', code: 'invalid-format' }
      ]
    })
    expect(await call(live, signed, 'createJournalEntry', researchCase.id, { ...entry, occurredAt: '2031-01-01T00:00:00.000Z' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [{ field: 'occurredAt', code: 'in-future' }]
    })

    await call(live, signed, 'archiveCase', researchCase.id)
    expect(await call(live, signed, 'createJournalEntry', researchCase.id, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'updateJournalEntry', researchCase.id, made.id, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call<JournalEntry[]>(live, signed, 'listJournalEntries', researchCase.id)).toEqual([made])
  })

  it('stores special characters verbatim', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const text = 'Niño “Ángel” <script>alert(1)</script> \'; DROP TABLE case_journal_entries; -- 🌽'
    await call(live, signed, 'createJournalEntry', researchCase.id, { ...entry, body: text, activity: 'Búsqueda <b>' })
    expect(await call<JournalEntry[]>(live, signed, 'listJournalEntries', researchCase.id)).toMatchObject([{ body: text, activity: 'Búsqueda <b>' }])
  })

  it('accepts an entry at its largest valid size', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const reply = await post(live, signed, 'createJournalEntry', [researchCase.id, { ...entry, body: '🌽'.repeat(5000), activity: 'a'.repeat(60) }])
    expect(reply.status).toBe(200)
    expect((reply.json() as { result: { ok: boolean } }).result.ok).toBe(true)
  })
})

describe('case journal call protection', () => {
  it('rejects extra keys, missing fields, wrong types and bad ids with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const made = created(await call(live, signed, 'createJournalEntry', researchCase.id, entry))
    const id = researchCase.id
    const badInputs: unknown[] = [
      { ...entry, id: made.id },
      { ...entry, caseId: id },
      { ...entry, createdAt: '2026-10-29T12:00:00.000Z' },
      { ...entry, updatedAt: '2026-10-29T12:00:00.000Z' },
      { ...entry, extra: 'x' },
      { occurredAt: entry.occurredAt, body: entry.body },
      { occurredAt: entry.occurredAt, activity: entry.activity },
      { ...entry, body: 42 },
      { ...entry, activity: 42 },
      { ...entry, occurredAt: 42 },
      { ...entry, body: undefined },
      'text',
      null
    ]
    for (const input of badInputs) {
      for (const [name, args] of [
        ['createJournalEntry', [id, input]],
        ['updateJournalEntry', [id, made.id, input]]
      ] as const) {
        const reply = await post(live, signed, name, [...args])
        expect(reply.status, `${name} ${JSON.stringify(input)?.slice(0, 60)}`).toBe(400)
        expect(reply.json()).toEqual({ error: 'invalid-arguments' })
      }
    }
    const badArgs: [string, unknown[]][] = [
      ['createJournalEntry', [id]],
      ['createJournalEntry', [id, entry, 'extra']],
      ['createJournalEntry', ['not-a-uuid', entry]],
      ['updateJournalEntry', [id, entry]],
      ['updateJournalEntry', [id, 'not-a-uuid', entry]],
      ['updateJournalEntry', ['not-a-uuid', made.id, entry]],
      ['updateJournalEntry', [id, made.id, entry, 'extra']],
      ['listJournalEntries', []],
      ['listJournalEntries', ['not-a-uuid']],
      ['listJournalEntries', [id, 'extra']],
      ['listJournalEntries', [42]]
    ]
    for (const [name, args] of badArgs) {
      const reply = await post(live, signed, name, args)
      expect(reply.status, name).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
    expect(await call<JournalEntry[]>(live, signed, 'listJournalEntries', id)).toEqual([made])
  })

  it('rejects oversized raw text with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const made = created(await call(live, signed, 'createJournalEntry', researchCase.id, entry))
    for (const [field, limit] of [
      ['body', 20_000],
      ['activity', 120],
      ['occurredAt', 64]
    ] as const) {
      const fine = await post(live, signed, 'createJournalEntry', [researchCase.id, { ...entry, [field]: 'x'.repeat(limit) }])
      expect(fine.status, field).toBe(200)
      for (const [name, args] of [
        ['createJournalEntry', [researchCase.id, { ...entry, [field]: 'x'.repeat(limit + 1) }]],
        ['updateJournalEntry', [researchCase.id, made.id, { ...entry, [field]: 'x'.repeat(limit + 1) }]]
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
      ['createJournalEntry', [crypto.randomUUID(), entry]],
      ['listJournalEntries', [crypto.randomUUID()]]
    ] as const) {
      const reply = await send(live, 'POST', `/api/v1/call/${name}`, headers, JSON.stringify({ args }))
      expect(reply.status).toBe(401)
    }
  })

  it('never puts submitted text in error bodies or logs', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const made = created(await call(live, signed, 'createJournalEntry', researchCase.id, entry))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'Fictional Secret Journal Text'

    const replies = [
      await post(live, signed, 'createJournalEntry', [researchCase.id, { ...entry, body: marker, extra: marker }]),
      await post(live, signed, 'createJournalEntry', [marker, entry]),
      await post(live, signed, 'createJournalEntry', [researchCase.id, { ...entry, body: `${marker}\u0000` }]),
      await post(live, signed, 'createJournalEntry', [crypto.randomUUID(), { ...entry, body: marker }]),
      await post(live, signed, 'updateJournalEntry', [researchCase.id, crypto.randomUUID(), { ...entry, body: marker }]),
      await post(live, signed, 'updateJournalEntry', [researchCase.id, made.id, { ...entry, activity: marker.repeat(3), body: marker }]),
      await post(live, signed, 'createJournalEntry', [researchCase.id, { ...entry, body: marker.repeat(1000) }])
    ]
    for (const reply of replies) expect(reply.text).not.toContain(marker)
    expect(replies.map((r) => r.status)).toEqual([400, 400, 200, 200, 200, 200, 400])
    expect([...logs, ...errors.mock.calls.flat()].join('\n')).not.toContain(marker)
    errors.mockRestore()
  })
})
