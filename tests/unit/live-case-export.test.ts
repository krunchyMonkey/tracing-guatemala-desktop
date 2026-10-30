import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadCaseSummaryData, type CaseSummarySource } from '../../src/renderer/src/cases/exportSummary'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { CaseMutationResult, ResearchCase } from '../../src/shared/case-model'
import { composeCaseSummary, summaryFileName } from '../../src/shared/case-summary'
import { call, signIn, type Signed } from './live-helpers'

// Case summary isolation (#20), the key acceptance check: with two clients and
// several look-alike cases each, a summary for one case contains all of its own
// text and none of any other case's or client's. The data is loaded with the real
// renderer loader (loadCaseSummaryData) over real HTTP against the Live web host
// and a real SQLite profile in a throwaway folder. Fictional data only.

let root: string
let dataDir: string
let staticDir: string
let server: RunningLiveServer | null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-live-export-test-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  server = null
})

afterEach(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

/** A source whose every call is a real HTTP call to the host. */
function httpRuntime(live: RunningLiveServer, signed: Signed): CaseSummarySource {
  const api = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => call(live, signed, name, ...args) })
  return { data: api as never, cases: api as never }
}

interface Seed {
  clientId: string
  caseRef: ResearchCase
  markers: string[]
}

async function seedClient(live: RunningLiveServer, signed: Signed, displayName: string, tag: string) {
  const made = await call<{ ok: true; client: { id: string } }>(live, signed, 'createClient', {
    displayName,
    source: 'fiverr',
    sourceDetail: `source-detail-${tag}`,
    fiverrUsername: `fiverr_${tag}`,
    email: `${tag}@example.com`,
    otherContact: `other-contact-${tag}`,
    preferredContactChannel: 'email'
  })
  const clientId = made.client.id
  await call(live, signed, 'createNote', clientId, {
    kind: 'note',
    occurredAt: '2026-10-20T10:00:00.000Z',
    channel: null,
    direction: null,
    body: `client-note-${tag}`
  })
  return { clientId, secrets: [`${tag}@example.com`, `fiverr_${tag}`, `other-contact-${tag}`, `source-detail-${tag}`, `client-note-${tag}`] }
}

async function seedCase(live: RunningLiveServer, signed: Signed, clientId: string, title: string, tag: string): Promise<Seed> {
  const made = await call<CaseMutationResult>(live, signed, 'createCase', clientId, {
    title,
    goal: `goal-${tag}`,
    orderReference: `ref-${tag}`,
    dueDate: '2026-11-15'
  })
  if (!made.ok) throw new Error('createCase failed')
  const id = made.case.id
  await call(live, signed, 'saveCaseBrief', id, {
    objective: `objective-${tag}`,
    facts: `facts-${tag}`,
    people: `people-${tag}`,
    hypotheses: `hypotheses-${tag}`,
    questions: `questions-${tag}`
  })
  await call(live, signed, 'createJournalEntry', id, { occurredAt: '2026-10-21T15:00:00.000Z', activity: `activity-${tag}`, body: `journal-${tag}` })
  await call(live, signed, 'createCaseTask', id, { title: `task-${tag}`, description: `task-detail-${tag}`, dueDate: '2026-11-05' })
  await call(live, signed, 'setCaseState', id, 'active')
  return {
    clientId,
    caseRef: made.case,
    markers: [
      `goal-${tag}`, `ref-${tag}`, `objective-${tag}`, `facts-${tag}`, `people-${tag}`, `hypotheses-${tag}`, `questions-${tag}`,
      `activity-${tag}`, `journal-${tag}`, `task-${tag}`, `task-detail-${tag}`
    ]
  }
}

describe('case summary isolation over the Live web host', () => {
  it('contains everything of the chosen case and nothing of other cases or clients', async () => {
    server = await startLiveServer({
      dataDir,
      port: 0,
      staticDir,
      appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
      log: () => undefined
    })
    const signed = await signIn(server)
    const runtime = httpRuntime(server, signed)

    // Look-alike clients and look-alike case titles, including the same title for two clients.
    const ana = await seedClient(server, signed, 'Ana Ejemplo', 'ana')
    const anita = await seedClient(server, signed, 'Ana Ejemplar', 'anita')
    const a1 = await seedCase(server, signed, ana.clientId, 'Maternal line', 'a1')
    const a2 = await seedCase(server, signed, ana.clientId, 'Maternal line 2', 'a2')
    const b1 = await seedCase(server, signed, anita.clientId, 'Maternal line', 'b1')
    const b2 = await seedCase(server, signed, anita.clientId, 'Maternal line — second', 'b2')
    const all = [a1, a2, b1, b2]

    for (const chosen of all) {
      const data = await loadCaseSummaryData(runtime, chosen.caseRef.id)
      expect(data).not.toBeNull()
      const text = composeCaseSummary(data!, {
        generatedAt: new Date('2026-10-30T18:00:00.000Z'),
        localToday: '2026-10-30',
        demo: false,
        timeZone: 'UTC'
      })

      for (const marker of chosen.markers) expect(text, `${marker} is missing`).toContain(marker)
      for (const other of all.filter((c) => c !== chosen)) {
        for (const marker of other.markers) expect(text, `${marker} leaked`).not.toContain(marker)
      }

      // The client: name only, never the other client's name or any contact detail or note.
      const ownerIsAna = chosen === a1 || chosen === a2
      expect(text).toContain(`- Client: ${ownerIsAna ? 'Ana Ejemplo' : 'Ana Ejemplar'}\n`)
      expect(text).not.toContain(ownerIsAna ? 'Ana Ejemplar' : 'Ana Ejemplo\n')
      for (const secret of [...ana.secrets, ...anita.secrets]) expect(text, `${secret} leaked`).not.toContain(secret)
      expect(text).not.toContain('@example.com')

      // Only this case's own history.
      expect(text.match(/Case created/g)).toHaveLength(1)
      expect(text.match(/Research started/g)).toHaveLength(1)
      expect(data!.events.every((event) => event.caseId === chosen.caseRef.id)).toBe(true)
    }
  })

  it('exports without changing anything stored', async () => {
    server = await startLiveServer({
      dataDir,
      port: 0,
      staticDir,
      appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
      log: () => undefined
    })
    const signed = await signIn(server)
    const runtime = httpRuntime(server, signed)
    const { clientId } = await seedClient(server, signed, 'Ana Ejemplo', 'ana')
    const seed = await seedCase(server, signed, clientId, 'Maternal line', 'a1')

    const snapshot = async () =>
      JSON.stringify([
        await call(server!, signed, 'listClients', { text: '', status: 'all', sources: [], sort: 'name' }),
        await call(server!, signed, 'listNotes', clientId),
        await call(server!, signed, 'listCases', { clientId: null, archived: 'all', states: [], text: '', sort: 'created' }),
        await call(server!, signed, 'getCaseBrief', seed.caseRef.id),
        await call(server!, signed, 'listJournalEntries', seed.caseRef.id),
        await call(server!, signed, 'listCaseTasks', seed.caseRef.id),
        await call(server!, signed, 'listCaseEvents', seed.caseRef.id)
      ])
    const before = await snapshot()
    const data = await loadCaseSummaryData(runtime, seed.caseRef.id)
    composeCaseSummary(data!, { generatedAt: new Date(), localToday: '2026-10-30', demo: false })
    summaryFileName(seed.caseRef.title, '2026-10-30')
    expect(await snapshot()).toBe(before)
  })

  it('returns null for an unknown case', async () => {
    server = await startLiveServer({
      dataDir,
      port: 0,
      staticDir,
      appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
      log: () => undefined
    })
    const runtime = httpRuntime(server, await signIn(server))
    expect(await loadCaseSummaryData(runtime, crypto.randomUUID())).toBeNull()
  })
})
