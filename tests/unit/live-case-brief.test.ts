import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { CaseBrief, CaseBriefInput, CaseBriefMutationResult } from '../../src/shared/case-brief'
import type { CaseMutationResult, ResearchCase } from '../../src/shared/case-model'
import { call, send, signIn, writeHeaders, type Signed } from './live-helpers'

// Case research brief calls (#17) over real HTTP on 127.0.0.1 against the Live
// web host, with throwaway data folders. Fictional data only.

const brief: CaseBriefInput = {
  objective: 'Establish where Rosa was born.',
  facts: 'The client says 1931.',
  people: 'Rosa Ejemplo (grandmother).',
  hypotheses: 'Possibly Totonicapán.',
  questions: 'Which parish book?'
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
  root = mkdtempSync(join(tmpdir(), 'tg-live-brief-test-'))
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
  const created = await call<CaseMutationResult>(live, signed, 'createCase', client.client.id, {
    title,
    goal: null,
    orderReference: null,
    dueDate: null
  })
  if (!created.ok) throw new Error('createCase failed')
  return created.case
}

const post = (live: RunningLiveServer, signed: Signed, name: string, args: unknown[]) =>
  send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, signed), JSON.stringify({ args }))

describe('case brief calls', () => {
  it('saves and reads a brief, an empty one first, and survives a host restart', async () => {
    let live = await start()
    let signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')

    expect(await call<CaseBrief>(live, signed, 'getCaseBrief', researchCase.id)).toEqual({
      caseId: researchCase.id,
      objective: null,
      facts: null,
      people: null,
      hypotheses: null,
      questions: null,
      updatedAt: null
    })
    expect(await call(live, signed, 'getCaseBrief', crypto.randomUUID())).toBeNull()

    const saved = await call<CaseBriefMutationResult>(live, signed, 'saveCaseBrief', researchCase.id, { ...brief, facts: '  trimmed\r\nlines  ' })
    expect(saved).toMatchObject({ ok: true, brief: { caseId: researchCase.id, ...brief, facts: 'trimmed\nlines' } })
    const stored = await call<CaseBrief>(live, signed, 'getCaseBrief', researchCase.id)

    await live.close()
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'getCaseBrief', researchCase.id)).toEqual(stored)
  })

  it('keeps briefs of two cases from different clients apart', async () => {
    const live = await start()
    const signed = await signIn(live)
    const caseA = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const caseB = await newCase(live, signed, 'Ana Ejemplar', 'Case B')
    await call(live, signed, 'saveCaseBrief', caseA.id, brief)
    expect(await call<CaseBrief>(live, signed, 'getCaseBrief', caseB.id)).toMatchObject({ objective: null, updatedAt: null })
    await call(live, signed, 'saveCaseBrief', caseB.id, { ...brief, objective: 'B only' })
    expect(await call<CaseBrief>(live, signed, 'getCaseBrief', caseA.id)).toMatchObject({ objective: brief.objective })
    expect(await call<CaseBrief>(live, signed, 'getCaseBrief', caseB.id)).toMatchObject({ objective: 'B only' })
  })

  it('answers unknown, archived and invalid saves with results, not errors', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    expect(await call(live, signed, 'saveCaseBrief', crypto.randomUUID(), brief)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'saveCaseBrief', researchCase.id, { ...brief, facts: 'x'.repeat(10_001), people: 'a\u0000b' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'facts', code: 'too-long' },
        { field: 'people', code: 'invalid-characters' }
      ]
    })
    await call(live, signed, 'archiveCase', researchCase.id)
    expect(await call(live, signed, 'saveCaseBrief', researchCase.id, brief)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call<CaseBrief>(live, signed, 'getCaseBrief', researchCase.id)).toMatchObject({ objective: null, updatedAt: null })
  })

  it('stores special characters verbatim', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const text = 'Niño “Ángel” <script>alert(1)</script> \'; DROP TABLE case_briefs; -- 🌽'
    await call(live, signed, 'saveCaseBrief', researchCase.id, { ...brief, hypotheses: text })
    expect(await call<CaseBrief>(live, signed, 'getCaseBrief', researchCase.id)).toMatchObject({ hypotheses: text })
  })

  it('accepts a brief at its largest valid size', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const biggest: CaseBriefInput = {
      objective: 'é'.repeat(4000),
      facts: '🌽'.repeat(5000),
      people: 'x\n'.repeat(4999),
      hypotheses: 'h'.repeat(10_000),
      questions: 'q'.repeat(10_000)
    }
    const reply = await post(live, signed, 'saveCaseBrief', [researchCase.id, biggest])
    expect(reply.status).toBe(200)
    expect((reply.json() as { result: { ok: boolean } }).result.ok).toBe(true)
  })
})

describe('case brief call protection', () => {
  it('rejects keys outside CaseBriefInput, missing fields and wrong types with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const missing = { objective: brief.objective, facts: brief.facts, people: brief.people, hypotheses: brief.hypotheses }
    const bad: unknown[][] = [
      [researchCase.id, { ...brief, caseId: researchCase.id }],
      [researchCase.id, { ...brief, updatedAt: '2026-10-29T12:00:00.000Z' }],
      [researchCase.id, { ...brief, extra: 'x' }],
      [researchCase.id, missing],
      [researchCase.id, { ...brief, facts: 42 }],
      [researchCase.id, { ...brief, facts: undefined }],
      [researchCase.id],
      [researchCase.id, brief, 'extra'],
      ['not-a-uuid', brief],
      [`${researchCase.id}x`, brief]
    ]
    for (const args of bad) {
      const reply = await post(live, signed, 'saveCaseBrief', args)
      expect(reply.status, JSON.stringify(args).slice(0, 80)).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
    for (const args of [['not-a-uuid'], [], [researchCase.id, 'extra'], [42]]) {
      const reply = await post(live, signed, 'getCaseBrief', args)
      expect(reply.status).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
    expect(await call<CaseBrief>(live, signed, 'getCaseBrief', researchCase.id)).toMatchObject({ updatedAt: null })
  })

  it('rejects oversized raw text with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    for (const field of ['objective', 'facts', 'people', 'hypotheses', 'questions'] as const) {
      const limit = field === 'objective' ? 4000 : 10_000
      const fine = await post(live, signed, 'saveCaseBrief', [researchCase.id, { ...brief, [field]: 'x'.repeat(limit * 2) }])
      expect(fine.status).toBe(200)
      expect((fine.json() as { result: { reason: string } }).result.reason).toBe('invalid')
      const reply = await post(live, signed, 'saveCaseBrief', [researchCase.id, { ...brief, [field]: 'x'.repeat(limit * 2 + 1) }])
      expect(reply.status, field).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
  })

  it('needs a session like every other call', async () => {
    const live = await start()
    const signed = await signIn(live)
    const headers: Record<string, string> = { ...writeHeaders(live, signed) }
    delete headers['Cookie']
    const reply = await send(live, 'POST', '/api/v1/call/saveCaseBrief', headers, JSON.stringify({ args: [crypto.randomUUID(), brief] }))
    expect(reply.status).toBe(401)
  })

  it('never puts submitted text in error bodies or logs', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'Fictional Secret Hypothesis'

    const replies = [
      await post(live, signed, 'saveCaseBrief', [researchCase.id, { ...brief, hypotheses: marker, extra: marker }]),
      await post(live, signed, 'saveCaseBrief', [marker, brief]),
      await post(live, signed, 'saveCaseBrief', [researchCase.id, { ...brief, hypotheses: `${marker}\u0000` }]),
      await post(live, signed, 'saveCaseBrief', [crypto.randomUUID(), { ...brief, hypotheses: marker }]),
      await post(live, signed, 'saveCaseBrief', [researchCase.id, { ...brief, hypotheses: marker.repeat(1000) }])
    ]
    for (const reply of replies) expect(reply.text).not.toContain(marker)
    expect(replies.map((r) => r.status)).toEqual([400, 400, 200, 200, 400])
    expect([...logs, ...errors.mock.calls.flat()].join('\n')).not.toContain(marker)
    errors.mockRestore()
  })
})
