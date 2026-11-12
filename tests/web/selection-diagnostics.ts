import type { Page, TestInfo } from '@playwright/test'

// Test-only diagnostics for the notebook selection flake (#250). Installs a small recorder in
// the page that logs, with timestamps: the DOM selection, the editor's (ProseMirror) selection,
// focus, key presses, mouse downs on the page, editor transactions, and the two editor-view
// calls that can write the editor's selection back into the DOM (view.focus, view.updateState).
// The log stays in the page; it is only read and attached to the test when something fails.
// Fictional test data only: the log holds the page's fictional text and nothing else.

export interface SelectionEvent {
  t: number
  kind: string
  detail?: unknown
  dom: { text: string; collapsed: boolean; anchor: string; anchorOffset: number; focus: string; focusOffset: number } | null
  pm: { from: number; to: number; type: string; text: string } | null
  editorFocused: boolean | null
  active: string
}

const LOG_LIMIT = 1500

/** Starts recording in the page (once per document; safe to call again). Call when the notebook page shows. */
export async function recordSelection(page: Page): Promise<void> {
  await page.evaluate((limit) => {
    interface PmSelection {
      from: number
      to: number
      constructor: { name: string }
      toJSON(): { type: string }
    }
    interface PmView {
      focus(): void
      updateState(state: unknown): void
    }
    interface PmEditor {
      state: { selection: PmSelection; doc: { textBetween(from: number, to: number, sep: string): string } }
      view: PmView & { __tgPatched?: boolean }
      isFocused: boolean
      on(event: 'transaction', fn: (props: { transaction: { docChanged: boolean; selectionSet: boolean; meta?: Record<string, unknown> } }) => void): void
    }
    const w = window as unknown as { __tgSelection?: { log: unknown[]; t0: number; editors: WeakSet<object> } }
    if (!w.__tgSelection) {
      w.__tgSelection = { log: [], t0: performance.now(), editors: new WeakSet() }
    }
    const rec = w.__tgSelection
    const describe = (node: Node | null): string => {
      if (!node) return 'none'
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
      const tag = element ? element.tagName.toLowerCase() : '?'
      const cls = element && typeof element.className === 'string' && element.className ? `.${element.className.split(/\s+/).join('.')}` : ''
      const kind = node.nodeType === Node.TEXT_NODE ? `#text("${(node.textContent ?? '').slice(0, 40)}") in ` : ''
      return `${kind}${tag}${cls}`
    }
    const editorOf = (): PmEditor | null => (document.querySelector('.ProseMirror') as unknown as { editor?: PmEditor } | null)?.editor ?? null
    const snap = (kind: string, detail?: unknown): void => {
      const ed = editorOf()
      const sel = document.getSelection()
      let pm: { from: number; to: number; type: string; text: string } | null = null
      try {
        if (ed) {
          const s = ed.state.selection
          pm = { from: s.from, to: s.to, type: s.toJSON().type, text: ed.state.doc.textBetween(s.from, s.to, '\n') }
        }
      } catch {
        pm = null
      }
      rec.log.push({
        t: Math.round(performance.now() - rec.t0),
        kind,
        detail,
        dom: sel
          ? {
              text: sel.toString(),
              collapsed: sel.isCollapsed,
              anchor: describe(sel.anchorNode),
              anchorOffset: sel.anchorOffset,
              focus: describe(sel.focusNode),
              focusOffset: sel.focusOffset
            }
          : null,
        pm,
        editorFocused: ed ? ed.isFocused : null,
        active: describe(document.activeElement)
      })
      if (rec.log.length > limit) rec.log.shift()
    }
    const stack = (): string[] => (new Error().stack ?? '').split('\n').slice(3, 9).map((line) => line.trim())

    if (!(rec as { listening?: boolean }).listening) {
      ;(rec as { listening?: boolean }).listening = true
      // Capture phase: runs before the editor's own selectionchange listener, so this sees the
      // DOM selection the editor is about to read, and how the editor maps it to positions.
      document.addEventListener(
        'selectionchange',
        () => {
          const ed = editorOf() as unknown as {
            view?: {
              docView?: { posFromDOM(node: Node, offset: number, bias: number): number }
              domObserver?: { currentSelection?: { anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number } }
            }
          } | null
          const sel = document.getSelection()
          let mapped: unknown = null
          try {
            const docView = ed?.view?.docView
            if (docView && sel?.anchorNode && sel.focusNode) {
              mapped = { anchorPos: docView.posFromDOM(sel.anchorNode, sel.anchorOffset, 1), headPos: docView.posFromDOM(sel.focusNode, sel.focusOffset, 1) }
            }
          } catch (error) {
            mapped = { error: String(error) }
          }
          const cur = ed?.view?.domObserver?.currentSelection
          snap('selectionchange:pre', {
            mapped,
            observerHad: cur ? { anchor: describe(cur.anchorNode), anchorOffset: cur.anchorOffset, focus: describe(cur.focusNode), focusOffset: cur.focusOffset } : null
          })
        },
        true
      )
      document.addEventListener('selectionchange', () => snap('selectionchange'))
      // Every script write to the DOM selection, with who made it.
      const proto = Selection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
      for (const name of ['collapse', 'setPosition', 'setBaseAndExtent', 'addRange', 'removeAllRanges', 'extend', 'collapseToStart', 'collapseToEnd', 'selectAllChildren']) {
        const original = proto[name]
        if (typeof original !== 'function') continue
        proto[name] = function (this: Selection, ...args: unknown[]) {
          const result = original.apply(this, args)
          snap(`dom.${name}`, { stack: stack() })
          return result
        }
      }
      document.addEventListener('keydown', (event) => snap('keydown', { key: event.key, shift: event.shiftKey, ctrl: event.ctrlKey }), true)
      document.addEventListener('mousedown', (event) => snap('mousedown', { target: describe(event.target as Node) }), true)
      document.addEventListener('focusin', (event) => snap('focusin', { target: describe(event.target as Node) }), true)
      document.addEventListener('focusout', (event) => snap('focusout', { target: describe(event.target as Node) }), true)
    }

    const ed = editorOf()
    if (ed && !rec.editors.has(ed)) {
      rec.editors.add(ed)
      ed.on('transaction', ({ transaction }) =>
        snap('transaction', { docChanged: transaction.docChanged, selectionSet: transaction.selectionSet, meta: Object.keys(transaction.meta ?? {}), stack: stack() })
      )
      const view = ed.view
      const focus = view.focus.bind(view)
      const updateState = view.updateState.bind(view)
      view.focus = () => {
        snap('view.focus:before', { stack: stack() })
        focus()
        snap('view.focus:after')
      }
      view.updateState = (state) => {
        updateState(state)
        snap('view.updateState', { stack: stack() })
      }
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
    const keep = log.filter((e) => e.kind !== 'keydown' && !(e.kind === 'transaction' && (e.detail as { docChanged?: boolean } | undefined)?.docChanged))
    console.log(`[#250 selection log: ${label}] last events (typing omitted; full log attached):\n${keep.slice(-80).map((e) => JSON.stringify(e)).join('\n')}`)
    throw error
  }
}
