import type { Page, TestInfo } from '@playwright/test'

// Test-only, failure-only diagnostics for the notebook selection steps (#250). A small recorder
// in the page logs, with timestamps, the DOM selection next to the editor's selection on
// selection changes, focus changes, mouse downs and editor transactions. It only listens:
// it does not wrap or patch any editor method and reads no editor internals, so it cannot
// change how the editor behaves. (An earlier, heavier version that captured stack traces
// changed the timing enough to make the journey fail 13 of 15 times.) The log stays in the
// page and is attached to the test only when a wrapped step fails.
// Fictional test data only: the log holds the page's fictional text and nothing else.

export interface SelectionEvent {
  t: number
  kind: string
  detail?: unknown
  dom: { text: string; collapsed: boolean } | null
  pm: { from: number; to: number; text: string } | null
  editorFocused: boolean | null
}

const LOG_LIMIT = 500

/** Starts recording in the page (once per document; safe to call again). Call when the notebook page shows. */
export async function recordSelection(page: Page): Promise<void> {
  await page.evaluate((limit) => {
    interface PmEditor {
      state: { selection: { from: number; to: number }; doc: { textBetween(from: number, to: number, sep: string): string } }
      isFocused: boolean
      on(event: 'transaction', fn: (props: { transaction: { docChanged: boolean; selectionSet: boolean } }) => void): void
    }
    const w = window as unknown as { __tgSelection?: { log: unknown[]; t0: number; editors: WeakSet<object>; listening: boolean } }
    w.__tgSelection ??= { log: [], t0: performance.now(), editors: new WeakSet(), listening: false }
    const rec = w.__tgSelection
    // The editor library exposes the editor on its root element.
    const editorOf = (): PmEditor | null => (document.querySelector('.ProseMirror') as unknown as { editor?: PmEditor } | null)?.editor ?? null
    const snap = (kind: string, detail?: unknown): void => {
      const ed = editorOf()
      const sel = document.getSelection()
      let pm: { from: number; to: number; text: string } | null = null
      try {
        if (ed) {
          const s = ed.state.selection
          pm = { from: s.from, to: s.to, text: ed.state.doc.textBetween(s.from, s.to, '\n') }
        }
      } catch {
        pm = null
      }
      rec.log.push({
        t: Math.round(performance.now() - rec.t0),
        kind,
        detail,
        dom: sel ? { text: sel.toString(), collapsed: sel.isCollapsed } : null,
        pm,
        editorFocused: ed ? ed.isFocused : null
      })
      if (rec.log.length > limit) rec.log.shift()
    }
    const tag = (target: EventTarget | null): string => (target instanceof Element ? target.tagName.toLowerCase() : 'none')

    if (!rec.listening) {
      rec.listening = true
      document.addEventListener('selectionchange', () => snap('selectionchange'))
      document.addEventListener('mousedown', (event) => snap('mousedown', { target: tag(event.target), clicks: event.detail }), true)
      document.addEventListener('focusin', (event) => snap('focusin', { target: tag(event.target) }), true)
      document.addEventListener('focusout', (event) => snap('focusout', { target: tag(event.target) }), true)
    }

    const ed = editorOf()
    if (ed && !rec.editors.has(ed)) {
      rec.editors.add(ed)
      ed.on('transaction', ({ transaction }) => {
        // Typing is not logged: only transactions that move the selection without editing.
        if (!transaction.docChanged && transaction.selectionSet) snap('transaction:selection')
      })
    }
    snap('recorder-installed')
  }, LOG_LIMIT)
}

/** Adds a named marker (with the current selections) to the page's log. */
export async function markSelection(page: Page, label: string): Promise<void> {
  await page.evaluate((name) => {
    const w = window as unknown as { __tgSelection?: { log: unknown[]; t0: number } }
    const rec = w.__tgSelection
    if (!rec) return
    const sel = document.getSelection()
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor?: { state: { selection: { from: number; to: number }; doc: { textBetween(a: number, b: number, s: string): string } }; isFocused: boolean } } | null)?.editor
    const s = ed?.state.selection
    rec.log.push({
      t: Math.round(performance.now() - rec.t0),
      kind: `mark:${name}`,
      dom: sel ? { text: sel.toString(), collapsed: sel.isCollapsed } : null,
      pm: ed && s ? { from: s.from, to: s.to, text: ed.state.doc.textBetween(s.from, s.to, '\n') } : null,
      editorFocused: ed ? ed.isFocused : null
    })
  }, label)
}

/** The page's log, or [] if no recorder runs. Never throws (the page may be gone). */
export async function readSelectionLog(page: Page): Promise<SelectionEvent[]> {
  try {
    return await page.evaluate(() => ((window as unknown as { __tgSelection?: { log: unknown[] } }).__tgSelection?.log ?? []) as SelectionEvent[])
  } catch {
    return []
  }
}

/**
 * Runs `step`; if it throws, attaches the selection log to the test (and prints its tail to the
 * CI log) before rethrowing. The assertion itself is never changed or retried here.
 */
export async function withSelectionLog<T>(page: Page, testInfo: TestInfo, label: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    const log = await readSelectionLog(page)
    await testInfo.attach(`selection-log-${label}`, { body: JSON.stringify(log, null, 2), contentType: 'application/json' })
    console.log(`[#250 selection log: ${label}] last 40 events (full log attached):\n${log.slice(-40).map((e) => JSON.stringify(e)).join('\n')}`)
    throw error
  }
}
