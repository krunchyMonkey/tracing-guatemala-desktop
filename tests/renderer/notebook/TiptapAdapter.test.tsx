// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTiptapAdapter, quietPastedHtml, type TiptapTestHandle } from '../../../src/renderer/src/notebook/adapters/tiptap/tiptapAdapter'
import { checkNoteContent, noteContentToPlainText, type NoteContent } from '../../../src/shared/note-content'
import type { RichTextEditorSession } from '../../../src/renderer/src/notebook/ports'
import { contractContent, describeEditorAdapterContract } from './editorAdapterContract'

// The real editor under jsdom: the shared contract, plus paste safety and ids.

beforeAll(() => {
  // jsdom has no layout; ProseMirror asks for rectangles when it scrolls the caret into view.
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  Range.prototype.getBoundingClientRect = () => rect as DOMRect
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  document.elementFromPoint = () => null
})

const handles = new Map<HTMLElement, TiptapTestHandle>()
const makeAdapter = () => createTiptapAdapter({ onSession: (handle, element) => handles.set(element, handle) })

describeEditorAdapterContract('tiptap', makeAdapter, {
  supportsMarks: true,
  simulateTyping: (_session, element, text) => handles.get(element)!.typeAtEnd(text),
  selectLastBlockText: (_session, element) => handles.get(element)!.selectLastBlockText(),
  selectDivider: (_session, element) => handles.get(element)!.selectDivider()
})

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function paste(element: HTMLElement, html: string, text = ''): void {
  const target = element.querySelector('.ProseMirror')!
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const data: Record<string, string> = { 'text/html': html, 'text/plain': text }
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '', files: [], items: [], types: Object.keys(data) } })
  target.dispatchEvent(event)
}

describe('tiptap adapter', () => {
  let session: RichTextEditorSession | null = null
  let counter = 5000
  afterEach(() => {
    session?.destroy()
    session = null
  })
  function mount(content: NoteContent = { format: 'tg-note', version: 1, blocks: [] }) {
    const element = document.createElement('div')
    document.body.append(element)
    const onChange = vi.fn()
    session = makeAdapter().create({ element, content, editable: true, label: 'Page text', placeholder: 'Start writing', newId: () => id(counter++), onChange })
    return { element, onChange, session }
  }

  it('describes itself as an accessible multi-line textbox and makes no inline styles', () => {
    const { element } = mount(contractContent())
    const surface = element.querySelector('.ProseMirror')!
    expect(surface.getAttribute('role')).toBe('textbox')
    expect(surface.getAttribute('aria-multiline')).toBe('true')
    expect(surface.getAttribute('aria-label')).toBe('Page text')
    expect(element.querySelectorAll('[style]')).toHaveLength(0)
    expect(document.head.querySelector('style')).toBeNull()
    expect(element.querySelector('input[type="checkbox"]')?.getAttribute('aria-label')).toBe('Task: Order microfilm')
    expect(element.querySelector('.note-reference .note-reference-label')?.textContent).toBe('Journal entry')
    expect(surface.querySelectorAll('[data-block-id]').length).toBeGreaterThanOrEqual(7)
  })

  it('shows reference labels as text, never as markup', () => {
    const element = document.createElement('div')
    session = makeAdapter().create({
      element,
      content: contractContent(),
      editable: true,
      label: 'x',
      newId: () => id(counter++),
      onChange: () => undefined,
      describeReference: () => '<img src=x onerror=alert(1)>'
    })
    const label = element.querySelector('.note-reference-label')!
    expect(label.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(label.children).toHaveLength(0)
  })

  it('refreshes reference labels when they change later, as text only', () => {
    let label = 'Journal entry'
    const element = document.createElement('div')
    const onChange = vi.fn()
    session = makeAdapter().create({
      element,
      content: contractContent(),
      editable: true,
      label: 'x',
      newId: () => id(counter++),
      onChange,
      describeReference: () => label
    })
    expect(element.querySelector('.note-reference-label')?.textContent).toBe('Journal entry')
    label = '<b>Journal · 12 Oct 2026</b>'
    session.refreshReferences()
    const shown = element.querySelector('.note-reference-label')!
    expect(shown.textContent).toBe('<b>Journal · 12 Oct 2026</b>')
    expect(shown.children).toHaveLength(0)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports a reference being activated by click or Enter, and makes it keyboard reachable', () => {
    const element = document.createElement('div')
    const onReferenceActivate = vi.fn()
    session = makeAdapter().create({ element, content: contractContent(), editable: false, label: 'x', newId: () => id(counter++), onChange: () => undefined, onReferenceActivate })
    const reference = element.querySelector<HTMLElement>('.note-reference')!
    expect(reference.tabIndex).toBe(0)
    expect(reference.getAttribute('role')).toBe('link')
    reference.click()
    reference.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    reference.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    expect(onReferenceActivate).toHaveBeenCalledTimes(2)
    expect(onReferenceActivate).toHaveBeenCalledWith({ kind: 'journal', id: id(100) })
  })

  it('inserts a reference after the selected block without replacing the selected text', () => {
    const { element, session: s } = mount({ format: 'tg-note', version: 1, blocks: [{ id: id(1), type: 'paragraph', indent: 0, content: [{ text: 'Closing words' }] }] })
    handles.get(element)!.selectLastBlockText()
    expect(s.run({ type: 'insertReference', target: { kind: 'task', id: id(200) } })).toBe(true)
    expect(s.getContent().blocks.map((b) => b.type)).toEqual(['paragraph', 'reference'])
    expect(noteContentToPlainText(s.getContent())).toContain('Closing words')
  })

  it('gives new blocks ids once, so they are stable across getContent calls', () => {
    const { element, session: s, onChange } = mount()
    handles.get(element)!.typeAtEnd('First line')
    const first = s.getContent()
    expect(first.blocks).toHaveLength(1)
    expect(checkNoteContent(first).issues).toEqual([])
    expect(s.getContent()).toEqual(first)
    expect(onChange).toHaveBeenCalled()
  })

  it('repairs a duplicate id in loaded content and keeps the first holder', () => {
    const { session: s } = mount(contractContent())
    s.setContent({ ...contractContent(), blocks: contractContent().blocks.map((b, i) => (i === 1 ? { ...b, id: id(1) } : b)) })
    const ids = s.getContent().blocks.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe(id(1))
    expect(checkNoteContent(s.getContent()).issues).toEqual([])
  })

  describe('pasting', () => {
    const hostile = [
      '<p>Safe text</p>',
      '<img src="x" onerror="alert(1)">',
      '<script>alert(1)</script>',
      '<iframe src="https://example.org"></iframe>',
      '<style>p{color:red}</style>',
      '<p style="color:red" onclick="alert(1)" class="evil" data-x="1">Styled <b onmouseover="x()">bold</b></p>',
      '<p><a href="javascript:alert(1)">bad link</a> and <a href="https://example.org/ok" target="_self" class="x" onclick="y()">good link</a></p>'
    ].join('')

    it('drops images, scripts, frames, styles and event handlers and keeps the text', () => {
      const { element, session: s, onChange } = mount()
      paste(element, hostile, 'fallback')
      const json = JSON.stringify(s.getContent())
      for (const bad of ['img', 'script', 'iframe', 'onerror', 'onclick', 'onmouseover', 'javascript', 'color:red', 'alert']) {
        expect(json).not.toContain(bad)
      }
      expect(checkNoteContent(s.getContent()).issues).toEqual([])
      const text = noteContentToPlainText(s.getContent())
      expect(text).toContain('Safe text')
      expect(text).toContain('Styled bold')
      expect(text).toContain('bad link and good link')
      expect(onChange).toHaveBeenCalled()
      expect(element.innerHTML).not.toMatch(/<img|<script|<iframe|<style|onerror|onclick|javascript:/i)
      const links = [...element.querySelectorAll('a')]
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.org/ok'])
      expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow')
      expect(links[0]!.getAttribute('target')).toBe('_blank')
      expect(links[0]!.getAttribute('class')).toBeNull()
    })

    it('keeps list structure from pasted HTML', () => {
      const { element, session: s } = mount()
      paste(element, '<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>')
      expect(s.getContent().blocks.map((b) => [b.type, 'indent' in b ? b.indent : null])).toEqual([
        ['bullet', 0],
        ['bullet', 1],
        ['bullet', 0]
      ])
    })

    it('does not turn pasted markdown-looking text into formatting', () => {
      const { element, session: s } = mount()
      paste(element, '<p>keep **these** stars</p>')
      expect(noteContentToPlainText(s.getContent()).trim()).toBe('keep **these** stars')
      expect(JSON.stringify(s.getContent())).not.toContain('bold')
    })
  })

  it('removes active markup from clipboard HTML but never touches text', () => {
    const html = '<p style="color:red" onclick="x()">Use style=bold and onclick=no in text</p><img src=x onerror=y()><script>z()</script><iframe src=a></iframe><a href="https://example.org" onmouseover=q>ok</a>'
    const quiet = quietPastedHtml(html)
    expect(quiet).toBe('<p>Use style=bold and onclick=no in text</p><a href="https://example.org">ok</a>')
  })

  it('makes a link only for safe addresses', () => {
    const { element, session: s } = mount(contractContent())
    handles.get(element)!.selectLastBlockText()
    expect(s.run({ type: 'setLink', href: 'javascript:alert(1)' })).toBe(false)
    expect(s.run({ type: 'setLink', href: 'mailto:person@example.org' })).toBe(true)
    expect(JSON.stringify(s.getContent())).toContain('mailto:person@example.org')
  })
})
