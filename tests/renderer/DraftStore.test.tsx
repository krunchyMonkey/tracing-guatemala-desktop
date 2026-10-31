// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clockTime, issueMessage, NotebookDraftStore, RETRY_DELAYS_MS, RETRY_REPEAT_MS, SAVE_DELAY_MS, statusText } from '../../src/renderer/src/notebook/draftStore'
import type { NoteContent } from '../../src/shared/note-content'
import type { NotebookPage, NotebookPageSaveResult, PageSave } from '../../src/shared/notebook'

// The draft store without React: debounce, one save in flight per page, backoff retries,
// the failure kinds, and conflict handling, all on fake timers. Fictional text only.

const CASE = '00000000-0000-4000-8000-000000000001'
const PAGE = '00000000-0000-4000-8000-000000000002'
const blockId = '00000000-0000-4000-8000-000000000003'

const doc = (text: string): NoteContent => ({ format: 'tg-note', version: 1, blocks: [{ id: blockId, type: 'paragraph', indent: 0, content: [{ text }] }] })
const pageAt = (version: number, text = 'Saved'): NotebookPage => ({
  id: PAGE,
  sectionId: '00000000-0000-4000-8000-000000000004',
  caseId: CASE,
  title: 'Visit',
  position: 0,
  version,
  archivedAt: null,
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-30T12:00:00.000Z',
  content: doc(text)
})

type SaveFn = (caseId: string, pageId: string, save: PageSave) => Promise<NotebookPageSaveResult>

function setup(save: SaveFn, now: () => Date = () => new Date(2026, 9, 30, 14, 5)) {
  const calls: PageSave[] = []
  const api = {
    saveNotebookPage: (caseId: string, pageId: string, body: PageSave) => {
      calls.push(structuredClone(body))
      return save(caseId, pageId, body)
    }
  }
  const store = new NotebookDraftStore(() => api, now)
  store.adopt(CASE, pageAt(1))
  return { store, calls }
}

const ok = (version: number, text: string): NotebookPageSaveResult => ({ ok: true, page: pageAt(version, text) })
const flush = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('NotebookDraftStore', () => {
  it('saves once, 800 ms after the last edit, with the latest text', async () => {
    const { store, calls } = setup(async (_c, _p, body) => ok(body.baseVersion + 1, 'x'))
    expect(SAVE_DELAY_MS).toBe(800)
    store.edit(PAGE, doc('a'))
    await flush(500)
    store.edit(PAGE, doc('ab'))
    await flush(500)
    store.edit(PAGE, doc('abc'))
    expect(store.get(PAGE)?.status).toBe('saving')
    await flush(799)
    expect(calls).toHaveLength(0)
    await flush(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ baseVersion: 1, content: doc('abc') })
    expect(store.get(PAGE)).toMatchObject({ status: 'saved', dirty: false, baseVersion: 2 })
    expect(statusText(store.get(PAGE))).toBe('Saved at 14:05')
    expect(store.hasUnsaved()).toBe(false)
  })

  it('keeps the edits on failure and retries after 1 s, 2 s, 5 s, 10 s, then every 30 s', async () => {
    let failing = true
    const { store, calls } = setup(async (_c, _p, body) => {
      if (failing) throw new Error('offline')
      return ok(body.baseVersion + 1, 'x')
    })
    expect([...RETRY_DELAYS_MS, RETRY_REPEAT_MS]).toEqual([1000, 2000, 5000, 10000, 30000])
    store.edit(PAGE, doc('Precious words.'))
    await flush(SAVE_DELAY_MS)
    expect(calls).toHaveLength(1)
    expect(store.get(PAGE)).toMatchObject({ status: 'retrying', dirty: true, content: doc('Precious words.') })
    expect(statusText(store.get(PAGE))).toBe('Not saved — retrying')
    expect(store.hasUnsaved()).toBe(true)

    let expected = 1
    for (const wait of [1000, 2000, 5000, 10000, 30000, 30000]) {
      await flush(wait - 1)
      expect(calls).toHaveLength(expected)
      await flush(1)
      expected += 1
      expect(calls).toHaveLength(expected)
    }
    // Every retry sent the same text on the same base version.
    expect(new Set(calls.map((c) => JSON.stringify(c))).size).toBe(1)

    failing = false
    await flush(30_000)
    expect(store.get(PAGE)).toMatchObject({ status: 'saved', dirty: false, baseVersion: 2 })
    expect(statusText(store.get(PAGE))).toMatch(/^Saved at \d\d:\d\d$/)
  })

  it('a missing page makes the draft read-only and says so, without retrying', async () => {
    const { store } = setup(async () => ({ ok: false, reason: 'not-found' }))
    store.edit(PAGE, doc('a'))
    await flush(SAVE_DELAY_MS)
    expect(store.get(PAGE)).toMatchObject({ status: 'locked', lockedReason: 'not-found', dirty: true })
    expect(statusText(store.get(PAGE))).toBe('Not saved — the page is gone')
  })

  it('"Retry now" tries at once and cancels the waiting time', async () => {
    let failing = true
    const { store, calls } = setup(async (_c, _p, body) => {
      if (failing) throw new Error('offline')
      return ok(body.baseVersion + 1, 'x')
    })
    store.edit(PAGE, doc('a'))
    await flush(SAVE_DELAY_MS)
    failing = false
    await store.retryNow(PAGE)
    expect(store.get(PAGE)?.status).toBe('saved')
    const count = calls.length
    await flush(60_000)
    expect(calls).toHaveLength(count)
  })

  it('queues edits made during a save and saves them after, on the new base version', async () => {
    const release: (() => void)[] = []
    const { store, calls } = setup(
      (_c, _p, body) =>
        new Promise((resolve) => {
          release.push(() => resolve(ok(body.baseVersion + 1, 'x')))
        })
    )
    store.edit(PAGE, doc('one'))
    await flush(SAVE_DELAY_MS)
    expect(calls).toHaveLength(1)
    // Typing while the first save is in flight: no second request until it finishes.
    store.edit(PAGE, doc('one two'))
    await flush(SAVE_DELAY_MS * 2)
    expect(calls).toHaveLength(1)
    release[0]!()
    await flush(0)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ baseVersion: 2, content: doc('one two') })
    expect(store.get(PAGE)).toMatchObject({ dirty: true, status: 'saving' })
    release[1]!()
    await flush(0)
    expect(store.get(PAGE)).toMatchObject({ dirty: false, status: 'saved', baseVersion: 3 })
  })

  it('does not retry a refused text until it changes; explains with a friendly message', async () => {
    const { store, calls } = setup(async () => ({ ok: false, reason: 'invalid', issues: [{ field: 'content', code: 'content-too-long' }] }))
    store.edit(PAGE, doc('huge'))
    await flush(SAVE_DELAY_MS)
    expect(store.get(PAGE)).toMatchObject({ status: 'invalid', issueCode: 'content-too-long', dirty: true })
    expect(statusText(store.get(PAGE))).toBe(`Couldn’t save: ${issueMessage('content-too-long')}`)
    expect(statusText(store.get(PAGE))).not.toContain('content-too-long')
    await flush(120_000)
    await store.flush(PAGE)
    expect(calls).toHaveLength(1)
    // The person asks again, or edits: it is sent again.
    await store.retryNow(PAGE)
    expect(calls).toHaveLength(2)
    store.edit(PAGE, doc('smaller'))
    await flush(SAVE_DELAY_MS)
    expect(calls).toHaveLength(3)
    expect(issueMessage('something-new')).toMatch(/can’t save/)
  })

  it('wrong-status makes the page read-only without retrying, and keeps the text', async () => {
    const { store, calls } = setup(async () => ({ ok: false, reason: 'wrong-status' }))
    store.edit(PAGE, doc('kept'))
    await flush(SAVE_DELAY_MS)
    expect(store.get(PAGE)).toMatchObject({ status: 'locked', lockedReason: 'wrong-status', content: doc('kept') })
    expect(statusText(store.get(PAGE))).toBe('Not saved — read-only')
    await flush(120_000)
    expect(calls).toHaveLength(1)
    expect(store.hasUnsaved()).toBe(true)
  })

  it('pauses on a conflict; Keep mine re-saves on the server version with keepPrevious', async () => {
    const { store, calls } = setup(async (_c, _p, body) => {
      if (body.baseVersion === 1) return { ok: false, reason: 'conflict', page: pageAt(4, 'Other window') }
      return ok(body.baseVersion + 1, 'x')
    })
    store.edit(PAGE, doc('Mine'))
    await flush(SAVE_DELAY_MS)
    expect(store.get(PAGE)).toMatchObject({ status: 'conflict', dirty: true })
    expect(store.get(PAGE)?.conflictPage?.version).toBe(4)
    // Editing or waiting does not save while the question is open.
    store.edit(PAGE, doc('Mine, more'))
    await flush(120_000)
    expect(calls).toHaveLength(1)
    await store.flush(PAGE)
    expect(calls).toHaveLength(1)

    await store.keepMine(PAGE)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ baseVersion: 4, content: doc('Mine, more'), keepPrevious: true })
    expect(store.get(PAGE)).toMatchObject({ status: 'saved', dirty: false, baseVersion: 5 })
  })

  it('keeps asking the host to keep the previous version until a keep-mine save works', async () => {
    let failing = true
    const { store, calls } = setup(async (_c, _p, body) => {
      if (body.baseVersion === 1) return { ok: false, reason: 'conflict', page: pageAt(2, 'Other') }
      if (failing) throw new Error('offline')
      return ok(body.baseVersion + 1, 'x')
    })
    store.edit(PAGE, doc('Mine'))
    await flush(SAVE_DELAY_MS)
    await store.keepMine(PAGE)
    expect(store.get(PAGE)?.status).toBe('retrying')
    failing = false
    await flush(1000)
    expect(calls.at(-1)).toEqual({ baseVersion: 2, content: doc('Mine'), keepPrevious: true })
    expect(store.get(PAGE)?.status).toBe('saved')
    // Later saves do not carry the flag.
    store.edit(PAGE, doc('Mine again'))
    await flush(SAVE_DELAY_MS)
    expect(calls.at(-1)).toEqual({ baseVersion: 3, content: doc('Mine again') })
  })

  it('Use the saved version drops the draft and hands back the other window\'s page', async () => {
    const { store } = setup(async () => ({ ok: false, reason: 'conflict', page: pageAt(3, 'Other window') }))
    store.edit(PAGE, doc('Mine'))
    await flush(SAVE_DELAY_MS)
    const saved = store.acceptSaved(PAGE)
    expect(saved?.version).toBe(3)
    expect(store.get(PAGE)).toMatchObject({ dirty: false, status: 'clean', baseVersion: 3, content: doc('Other window') })
    expect(store.hasUnsaved()).toBe(false)
    expect(store.acceptSaved(PAGE)).toBeNull()
  })

  it('keeps drafts of several pages, lists the unsaved ones and forgets a discarded draft', async () => {
    const { store } = setup(async () => {
      throw new Error('offline')
    })
    const other = { ...pageAt(1), id: '00000000-0000-4000-8000-000000000009' }
    store.adopt(CASE, other)
    store.edit(PAGE, doc('a'))
    store.edit(other.id, doc('b'))
    expect(store.unsavedPages().map((d) => d.pageId).sort()).toEqual([PAGE, other.id].sort())
    // A page with unsaved text is not overwritten by a fresh load.
    store.adopt(CASE, pageAt(7, 'server'))
    expect(store.get(PAGE)).toMatchObject({ content: doc('a'), baseVersion: 1 })
    store.discard(other.id)
    expect(store.unsavedPages().map((d) => d.pageId)).toEqual([PAGE])
    await flush(SAVE_DELAY_MS)
  })

  it('formats the clock in local time', () => {
    expect(clockTime(new Date(2026, 9, 30, 9, 3))).toBe('09:03')
    expect(statusText(undefined)).toBe('')
  })
})
