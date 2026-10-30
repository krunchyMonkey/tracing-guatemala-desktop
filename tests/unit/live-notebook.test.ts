import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { CaseMutationResult, ResearchCase } from '../../src/shared/case-model'
import type { NoteBlock, NoteContent } from '../../src/shared/note-content'
import type { NotebookOutline, NotebookPage, NotebookSection, PageRevisionSummary } from '../../src/shared/notebook'
import { call, send, signIn, without, writeHeaders, type Signed } from './live-helpers'

// Research notebook calls (#147) over real HTTP on 127.0.0.1 against the Live
// web host, with throwaway data folders. Fictional data only.

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
  root = mkdtempSync(join(tmpdir(), 'tg-live-notebook-test-'))
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
  const created = await call<CaseMutationResult>(live, signed, 'createCase', clientId, { title, goal: null, orderReference: null, dueDate: null })
  if (!created.ok) throw new Error('createCase failed')
  return created.case
}

const newCase = async (live: RunningLiveServer, signed: Signed, displayName: string, title: string) =>
  newCaseFor(live, signed, await newClient(live, signed, displayName), title)

const post = (live: RunningLiveServer, signed: Signed, name: string, args: unknown[]) =>
  send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, signed), JSON.stringify({ args }))

const blockId = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const paragraph = (n: number, text: string): NoteBlock => ({ id: blockId(n), type: 'paragraph', indent: 0, content: [{ text }] })
const doc = (...blocks: NoteBlock[]): NoteContent => ({ format: 'tg-note', version: 1, blocks })

type PageReply = { ok: true; page: NotebookPage } | { ok: false; reason: string }

function pageOf(result: PageReply): NotebookPage {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.page
}
const newSection = async (live: RunningLiveServer, signed: Signed, caseId: string, title: string): Promise<NotebookSection> => {
  const result = await call<{ ok: true; section: NotebookSection } | { ok: false; reason: string }>(live, signed, 'createNotebookSection', caseId, { title })
  if (!result.ok) throw new Error(`createNotebookSection: ${result.reason}`)
  return result.section
}
const newPage = async (live: RunningLiveServer, signed: Signed, caseId: string, sectionId: string, title: string): Promise<NotebookPage> =>
  pageOf(await call<PageReply>(live, signed, 'createNotebookPage', caseId, sectionId, { title }))

describe('notebook calls', () => {
  it('creates, edits, saves, restores and survives a host restart', async () => {
    let live = await start()
    let signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const id = researchCase.id

    expect(await call(live, signed, 'getNotebook', crypto.randomUUID())).toBeNull()
    expect(await call(live, signed, 'getNotebook', id)).toEqual({ caseId: id, notebookId: null, sections: [] })

    const a = await newSection(live, signed, id, '  Archive visits ')
    const b = await newSection(live, signed, id, 'Interviews')
    expect(a).toMatchObject({ title: 'Archive visits', position: 0 })
    await call(live, signed, 'moveNotebookSection', id, b.id, 0)
    await call(live, signed, 'renameNotebookSection', id, a.id, { title: 'Archive trips' })
    const p = await newPage(live, signed, id, a.id, 'First visit')
    expect(p).toMatchObject({ version: 1, content: { format: 'tg-note', version: 1, blocks: [] } })
    await call(live, signed, 'renameNotebookPage', id, p.id, { title: 'First trip' })

    const saved = pageOf(await call<PageReply>(live, signed, 'saveNotebookPage', id, p.id, { baseVersion: 1, content: doc(paragraph(1, 'Niño “Ángel” <b>')) }))
    expect(saved).toMatchObject({ version: 2, title: 'First trip' })
    expect(await call(live, signed, 'saveNotebookPage', id, p.id, { baseVersion: 1, content: doc(paragraph(1, 'stale')) })).toMatchObject({
      ok: false,
      reason: 'conflict',
      page: { version: 2 }
    })
    const revisions = await call<PageRevisionSummary[]>(live, signed, 'listPageRevisions', id, p.id)
    expect(revisions).toMatchObject([{ reason: 'autosave', version: 2 }])
    expect(await call(live, signed, 'getPageRevision', id, p.id, revisions[0]!.id)).toMatchObject({ content: saved.content })
    await call(live, signed, 'saveNotebookPage', id, p.id, { baseVersion: 2, content: doc() })
    const restored = pageOf(await call<PageReply>(live, signed, 'restorePageRevision', id, p.id, revisions[0]!.id, 3))
    expect(restored).toMatchObject({ version: 4, content: saved.content })

    const q = await newPage(live, signed, id, b.id, 'Elsewhere')
    await call(live, signed, 'moveNotebookPage', id, q.id, { sectionId: a.id, toIndex: 0 })
    await call(live, signed, 'archiveNotebookPage', id, q.id)
    await call(live, signed, 'archiveNotebookSection', id, b.id)

    const outline = await call<NotebookOutline>(live, signed, 'getNotebook', id)
    const history = await call<PageRevisionSummary[]>(live, signed, 'listPageRevisions', id, p.id)
    const current = await call<NotebookPage>(live, signed, 'getNotebookPage', id, p.id)
    expect(current).toMatchObject({ position: 1, content: saved.content })
    expect(outline.sections.map((s) => [s.title, s.archivedAt !== null, s.pages.map((x) => [x.title, x.archivedAt !== null])])).toEqual([
      ['Interviews', true, []],
      ['Archive trips', false, [['Elsewhere', true], ['First trip', false]]]
    ])
    expect(history.map((r) => r.reason)).toEqual(['restored', 'restore-point', 'autosave'])

    await live.close()
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'getNotebook', id)).toEqual(outline)
    expect(await call(live, signed, 'listPageRevisions', id, p.id)).toEqual(history)
    expect(await call(live, signed, 'getNotebookPage', id, p.id)).toEqual(current)
  })

  it('keeps notebooks of cases and clients apart', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed, 'Ana Ejemplo')
    const caseA = await newCaseFor(live, signed, clientId, 'Case A')
    const caseA2 = await newCaseFor(live, signed, clientId, 'Case A2')
    const caseB = await newCase(live, signed, 'Beatriz Muestra', 'Case B')
    const sA = await newSection(live, signed, caseA.id, 'In A')
    const pA = await newPage(live, signed, caseA.id, sA.id, 'Page A')
    await call(live, signed, 'saveNotebookPage', caseA.id, pA.id, { baseVersion: 1, content: doc(paragraph(1, 'private')) })
    const revision = (await call<PageRevisionSummary[]>(live, signed, 'listPageRevisions', caseA.id, pA.id))[0]!
    const sB = await newSection(live, signed, caseB.id, 'In B')

    const missing = { ok: false, reason: 'not-found' }
    for (const other of [caseB.id, caseA2.id]) {
      expect(await call(live, signed, 'getNotebookPage', other, pA.id)).toBeNull()
      expect(await call(live, signed, 'listPageRevisions', other, pA.id)).toEqual([])
      expect(await call(live, signed, 'getPageRevision', other, pA.id, revision.id)).toBeNull()
      expect(await call(live, signed, 'renameNotebookSection', other, sA.id, { title: 'x' })).toEqual(missing)
      expect(await call(live, signed, 'createNotebookPage', other, sA.id, { title: 'x' })).toEqual(missing)
      expect(await call(live, signed, 'saveNotebookPage', other, pA.id, { baseVersion: 2, content: doc(paragraph(2, 'stolen')) })).toEqual(missing)
      expect(await call(live, signed, 'restorePageRevision', other, pA.id, revision.id, 2)).toEqual(missing)
    }
    expect(await call(live, signed, 'moveNotebookPage', caseA.id, pA.id, { sectionId: sB.id, toIndex: 0 })).toEqual(missing)
    expect(await call(live, signed, 'getNotebook', caseA2.id)).toEqual({ caseId: caseA2.id, notebookId: null, sections: [] })
    expect(await call(live, signed, 'getNotebookPage', caseA.id, pA.id)).toMatchObject({ version: 2, content: doc(paragraph(1, 'private')) })
  })

  it('answers archived cases with wrong-status and still serves reads', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const s = await newSection(live, signed, researchCase.id, 'S')
    const p = await newPage(live, signed, researchCase.id, s.id, 'P')
    await call(live, signed, 'archiveCase', researchCase.id)
    expect(await call(live, signed, 'createNotebookSection', researchCase.id, { title: 'x' })).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'saveNotebookPage', researchCase.id, p.id, { baseVersion: 1, content: doc(paragraph(1, 'x')) })).toEqual({
      ok: false,
      reason: 'wrong-status'
    })
    expect(await call(live, signed, 'createNotebookSection', crypto.randomUUID(), { title: 'x' })).toEqual({ ok: false, reason: 'not-found' })
    expect((await call<NotebookOutline>(live, signed, 'getNotebook', researchCase.id)).sections).toHaveLength(1)
    expect(await call(live, signed, 'getNotebookPage', researchCase.id, p.id)).toMatchObject({ id: p.id })
  })

  it('answers invalid content with typed issues and no echo', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const s = await newSection(live, signed, researchCase.id, 'S')
    const p = await newPage(live, signed, researchCase.id, s.id, 'P')
    const marker = 'Fictional Secret Page Text'
    const reply = await post(live, signed, 'saveNotebookPage', [
      researchCase.id,
      p.id,
      {
        baseVersion: 1,
        content: doc({ id: blockId(1), type: 'paragraph', indent: 0, content: [{ text: marker, href: 'javascript:alert(1)' }] }, paragraph(1, 'dup'))
      }
    ])
    expect(reply.status).toBe(200)
    const result = (reply.json() as { result: { ok: boolean; reason: string; issues: { field: string; code: string }[] } }).result
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(result.issues.map((i) => [i.field, i.code])).toContainEqual(['content', 'invalid-href'])
    expect(reply.text).not.toContain(marker)
    expect(await call(live, signed, 'createNotebookSection', researchCase.id, { title: '   ' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [{ field: 'title', code: 'required' }]
    })
  })
})

describe('notebook call protection', () => {
  it('rejects extra keys, bad shapes, unknown block types and bad ids with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const id = researchCase.id
    const s = await newSection(live, signed, id, 'S')
    const p = await newPage(live, signed, id, s.id, 'P')
    const content = doc(paragraph(1, 'x'))
    const withBlocks = (blocks: unknown[]) => ({ baseVersion: 1, content: { ...content, blocks } })
    const badArgs: [string, unknown[]][] = [
      ['createNotebookSection', [id, { title: 'x', extra: 1 }]],
      ['createNotebookSection', [id, {}]],
      ['createNotebookSection', [id, { title: 42 }]],
      ['createNotebookSection', ['not-a-uuid', { title: 'x' }]],
      ['createNotebookSection', [id, { title: 'x' }, 'extra']],
      ['renameNotebookSection', [id, s.id, { id: s.id, title: 'x' }]],
      ['moveNotebookSection', [id, s.id, -1]],
      ['moveNotebookSection', [id, s.id, 1.5]],
      ['moveNotebookSection', [id, s.id, '0']],
      ['createNotebookPage', [id, s.id, { title: 'x', content }]],
      ['createNotebookPage', [id, 'not-a-uuid', { title: 'x' }]],
      ['moveNotebookPage', [id, p.id, { sectionId: s.id }]],
      ['moveNotebookPage', [id, p.id, { sectionId: s.id, toIndex: 0, extra: 1 }]],
      ['saveNotebookPage', [id, p.id, { content }]],
      ['saveNotebookPage', [id, p.id, { baseVersion: 0, content }]],
      ['saveNotebookPage', [id, p.id, { baseVersion: 1.5, content }]],
      ['saveNotebookPage', [id, p.id, { baseVersion: 1, content, extra: 1 }]],
      ['saveNotebookPage', [id, p.id, { baseVersion: 1, content: { ...content, extra: 1 } }]],
      ['saveNotebookPage', [id, p.id, { baseVersion: 1, content: { ...content, version: 2 } }]],
      ['saveNotebookPage', [id, p.id, withBlocks([{ id: blockId(1), type: 'script', content: [] }])]],
      ['saveNotebookPage', [id, p.id, withBlocks([{ ...paragraph(1, 'x'), extra: 1 }])]],
      ['saveNotebookPage', [id, p.id, withBlocks([{ id: blockId(1), type: 'heading', level: 4, content: [] }])]],
      ['saveNotebookPage', [id, p.id, withBlocks([{ id: blockId(1), type: 'paragraph', indent: 0, content: [{ text: 'x', marks: ['blink'] }] }])]],
      ['saveNotebookPage', [id, p.id, withBlocks([{ id: blockId(1), type: 'paragraph', indent: 0, content: [{ text: 'x', style: 'red' }] }])]],
      ['saveNotebookPage', [id, p.id, { baseVersion: 1, content: null }]],
      ['restorePageRevision', [id, p.id, crypto.randomUUID()]],
      ['restorePageRevision', [id, p.id, crypto.randomUUID(), 0]],
      ['getNotebook', []],
      ['getNotebook', [id, 'extra']],
      ['getNotebookPage', [id]],
      ['listPageRevisions', [id, 'not-a-uuid']],
      ['getPageRevision', [id, p.id]]
    ]
    for (const [name, args] of badArgs) {
      const reply = await post(live, signed, name, args)
      expect(reply.status, `${name} ${JSON.stringify(args).slice(0, 80)}`).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
    expect(await call(live, signed, 'getNotebookPage', id, p.id)).toMatchObject({ version: 1, title: 'P' })
  })

  it('rejects oversized raw text and too many blocks with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const s = await newSection(live, signed, researchCase.id, 'S')
    const p = await newPage(live, signed, researchCase.id, s.id, 'P')
    expect((await post(live, signed, 'createNotebookSection', [researchCase.id, { title: 'x'.repeat(160) }])).status).toBe(200)
    expect((await post(live, signed, 'createNotebookSection', [researchCase.id, { title: 'x'.repeat(161) }])).status).toBe(400)
    expect((await post(live, signed, 'createNotebookPage', [researchCase.id, s.id, { title: 'x'.repeat(241) }])).status).toBe(400)
    const blocks = Array.from({ length: 10_001 }, (_, i) => ({ id: blockId(i + 1), type: 'divider' }))
    const reply = await post(live, signed, 'saveNotebookPage', [researchCase.id, p.id, { baseVersion: 1, content: { format: 'tg-note', version: 1, blocks } }])
    expect(reply.status).toBe(400)
  })

  it('needs a session, the CSRF token and the same origin', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const body = JSON.stringify({ args: [researchCase.id, { title: 'x' }] })
    const headers = writeHeaders(live, signed)
    const attempt = (h: Record<string, string>) => send(live, 'POST', '/api/v1/call/createNotebookSection', h, body)

    expect((await attempt(without(headers, 'Cookie'))).status).toBe(401)
    expect((await attempt(without(headers, 'X-TG-CSRF'))).status).toBe(403)
    expect((await attempt({ ...headers, 'X-TG-CSRF': 'wrong-token' })).status).toBe(403)
    expect((await attempt({ ...headers, Origin: 'http://evil.example' })).status).toBe(403)
    expect((await call<NotebookOutline>(live, signed, 'getNotebook', researchCase.id)).sections).toEqual([])
    expect((await attempt(headers)).status).toBe(200)
  })

  it('never puts submitted text in error bodies or logs', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const s = await newSection(live, signed, researchCase.id, 'S')
    const p = await newPage(live, signed, researchCase.id, s.id, 'P')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'Fictional Secret Notebook Text'

    const replies = [
      await post(live, signed, 'createNotebookSection', [researchCase.id, { title: marker, extra: marker }]),
      await post(live, signed, 'createNotebookSection', [marker, { title: marker }]),
      await post(live, signed, 'createNotebookPage', [researchCase.id, crypto.randomUUID(), { title: marker }]),
      await post(live, signed, 'saveNotebookPage', [researchCase.id, p.id, { baseVersion: 1, content: doc({ id: blockId(1), type: 'script', content: marker } as unknown as NoteBlock) }]),
      // A conflict returns the stored page, never the submitted text.
      await post(live, signed, 'saveNotebookPage', [researchCase.id, p.id, { baseVersion: 7, content: doc(paragraph(1, marker)) }]),
      await post(live, signed, 'renameNotebookPage', [researchCase.id, p.id, { title: `${marker}\u0000` }])
    ]
    for (const reply of replies) expect(reply.text).not.toContain(marker)
    expect(replies.map((r) => r.status)).toEqual([400, 400, 200, 400, 200, 200])
    expect([...logs, ...errors.mock.calls.flat()].join('\n')).not.toContain(marker)
    errors.mockRestore()
  })
})

describe('page size', () => {
  /** About 600 KB of JSON within the content limits: 42 blocks of 500 alternating-mark runs. */
  function bigPage(): NoteContent {
    return doc(
      ...Array.from(
        { length: 42 },
        (_, b): NoteBlock => ({
          id: blockId(b + 1),
          type: 'paragraph',
          indent: 0,
          content: Array.from({ length: 500 }, (_, i) => ({ text: 'a', marks: i % 2 === 0 ? ['bold' as const] : ['italic' as const] }))
        })
      )
    )
  }

  it('saves and reads a ~600 KB page, and refuses a body over 1 MiB with 413', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const s = await newSection(live, signed, researchCase.id, 'S')
    const p = await newPage(live, signed, researchCase.id, s.id, 'Big')
    const content = bigPage()
    const body = JSON.stringify({ args: [researchCase.id, p.id, { baseVersion: 1, content }] })
    expect(body.length).toBeGreaterThan(500_000)
    expect(body.length).toBeLessThan(1024 * 1024)

    const reply = await send(live, 'POST', '/api/v1/call/saveNotebookPage', writeHeaders(live, signed), body)
    expect(reply.status, reply.text.slice(0, 200)).toBe(200)
    expect((reply.json() as { result: { ok: boolean; page: NotebookPage } }).result).toMatchObject({ ok: true, page: { version: 2 } })
    expect(await call(live, signed, 'getNotebookPage', researchCase.id, p.id)).toMatchObject({ version: 2, content })

    const huge = JSON.stringify({ args: [researchCase.id, p.id, { baseVersion: 2, content: doc(paragraph(1, 'x'.repeat(1_100_000))) }] })
    expect((await send(live, 'POST', '/api/v1/call/saveNotebookPage', writeHeaders(live, signed), huge)).status).toBe(413)
    expect(await call(live, signed, 'getNotebookPage', researchCase.id, p.id)).toMatchObject({ version: 2 })
  })
})
