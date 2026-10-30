import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CALL_NAMES } from '../../src/server/live-host'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { CaseMutationResult } from '../../src/shared/case-model'
import type { StudioSummary } from '../../src/shared/studio-summary'
import { call, send, signIn, writeHeaders, without } from './live-helpers'

// The Research Studio summary call (#116) over real HTTP on 127.0.0.1 against the Live
// web host, with throwaway data folders. Fictional data only.

let root: string
let server: RunningLiveServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tg-live-studio-test-'))
  const staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  server = await startLiveServer({
    dataDir: join(root, 'profile'),
    port: 0,
    staticDir,
    appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
    log: () => {}
  })
})

afterEach(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

const post = (headers: Record<string, string>) => send(server, 'POST', '/api/v1/call/getStudioSummary', headers, JSON.stringify({ args: [] }))

describe('getStudioSummary over HTTP', () => {
  it('is a registered call', () => {
    expect(CALL_NAMES).toContain('getStudioSummary')
  })

  it('returns the zero state for an empty profile, then reflects a new client, case and task', async () => {
    const signed = await signIn(server)
    const empty = await call<StudioSummary>(server, signed, 'getStudioSummary')
    expect(empty.counts).toMatchObject({ activeClients: 0, openCases: 0, overdueTasks: 0, tasksDueSoon: 0 })
    expect(empty.continueCase).toBeNull()
    expect(empty.hours).toEqual({ weekMinutes: 0, monthMinutes: 0 })

    const client = await call<{ ok: true; client: { id: string } }>(server, signed, 'createClient', {
      displayName: 'Ana Ejemplo',
      source: 'direct',
      sourceDetail: null,
      fiverrUsername: null,
      email: 'ana@example.com',
      otherContact: null,
      preferredContactChannel: 'unspecified'
    })
    const made = await call<CaseMutationResult>(server, signed, 'createCase', client.client.id, {
      title: 'Maternal grandparents',
      goal: 'Fictional goal text',
      orderReference: null,
      dueDate: null
    })
    if (!made.ok) throw new Error('createCase failed')
    await call(server, signed, 'createCaseTask', made.case.id, { title: 'Request the register', description: 'Fictional detail', dueDate: '2000-01-01' })

    const summary = await call<StudioSummary>(server, signed, 'getStudioSummary')
    expect(summary.counts).toMatchObject({ activeClients: 1, openCases: 1, overdueTasks: 1 })
    expect(summary.continueCase).toMatchObject({ caseId: made.case.id, clientDisplayName: 'Ana Ejemplo', state: 'intake' })
    expect(summary.upcomingTasks[0]).toMatchObject({ title: 'Request the register', overdue: true })
    const text = JSON.stringify(summary)
    expect(text).not.toContain('Fictional goal text')
    expect(text).not.toContain('Fictional detail')
    expect(text).not.toContain('ana@example.com')
  })

  it('rejects calls without a session, with a wrong Origin or Host, and without the CSRF token', async () => {
    const signed = await signIn(server)
    const headers = writeHeaders(server, signed)
    expect((await post(headers)).status).toBe(200)
    expect((await post(without(headers, 'Cookie'))).status).toBe(401)
    expect((await post({ ...headers, Origin: 'http://evil.example' })).status).toBe(403)
    expect((await post(without(headers, 'Origin'))).status).toBe(403)
    expect((await post(without(headers, 'X-TG-CSRF'))).status).toBe(403)
    expect((await post({ ...headers, Host: 'evil.example' })).status).toBe(421)
  })

  it('takes no input: extra arguments are refused', async () => {
    const signed = await signIn(server)
    const reply = await send(server, 'POST', '/api/v1/call/getStudioSummary', writeHeaders(server, signed), JSON.stringify({ args: ['x'] }))
    expect(reply.status).toBe(400)
  })
})
