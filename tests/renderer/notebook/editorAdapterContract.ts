import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkNoteContent, noteContentToPlainText, type NoteBlock, type NoteContent } from '../../../src/shared/note-content'
import type { EditorState, RichTextEditorAdapter, RichTextEditorSession } from '../../../src/renderer/src/notebook/ports'

// The behavior every RichTextEditorAdapter must have. Run it against a new adapter
// with describeEditorAdapterContract(name, makeAdapter, driver) (docs/architecture/research-notebook.md).

export interface EditorContractDriver {
  /** Simulates the user typing `text` at the end of the document's last block. */
  simulateTyping(session: RichTextEditorSession, element: HTMLElement, text: string): void
  /** Whether toggleMark and setLink are honored (false for a plain-text fallback). */
  supportsMarks: boolean
  /** Optional: selects the text of the last block, for editors where marks and links need a selection. */
  selectLastBlockText?(session: RichTextEditorSession, element: HTMLElement): void
  /** Optional: puts the caret on the divider, for editors whose caret moves past it when one is inserted. */
  selectDivider?(session: RichTextEditorSession, element: HTMLElement): void
}

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** The last block is a paragraph, so "type at the end" is the same in every adapter. */
export function contractContent(): NoteContent {
  return {
    format: 'tg-note',
    version: 1,
    blocks: [
      { id: id(1), type: 'heading', level: 1, content: [{ text: 'Parish of San Rafael' }] },
      { id: id(2), type: 'paragraph', indent: 0, content: [{ text: 'Searched the baptism index.' }] },
      { id: id(3), type: 'bullet', indent: 0, content: [{ text: 'Ask the archivist' }] },
      { id: id(4), type: 'check', indent: 1, checked: true, content: [{ text: 'Order microfilm' }] },
      { id: id(5), type: 'divider' },
      { id: id(6), type: 'reference', target: { kind: 'journal', id: id(100) } },
      { id: id(7), type: 'paragraph', indent: 0, content: [{ text: 'Closing words' }] }
    ]
  }
}

const last = (content: NoteContent): NoteBlock => content.blocks[content.blocks.length - 1]!

export function describeEditorAdapterContract(name: string, makeAdapter: () => RichTextEditorAdapter, driver: EditorContractDriver): void {
  describe(`RichTextEditorAdapter contract: ${name}`, () => {
    let element: HTMLElement
    let sessions: RichTextEditorSession[]
    let counter: number
    let onChange: ReturnType<typeof vi.fn<(content: NoteContent) => void>>
    let states: EditorState[]

    beforeEach(() => {
      element = document.createElement('div')
      sessions = []
      counter = 1000
      onChange = vi.fn()
      states = []
    })
    afterEach(() => sessions.forEach((s) => s.destroy()))

    function mount(overrides: { content?: NoteContent; editable?: boolean } = {}): RichTextEditorSession {
      const session = makeAdapter().create({
        element,
        content: overrides.content ?? contractContent(),
        editable: overrides.editable ?? true,
        label: 'Page text',
        placeholder: 'Start writing',
        newId: () => id(counter++),
        onChange,
        onStateChange: (state) => states.push(state)
      })
      sessions.push(session)
      return session
    }
    const type = (session: RichTextEditorSession, text: string): void => driver.simulateTyping(session, element, text)

    it('identifies itself and gives the surface an accessible name', () => {
      const adapter = makeAdapter()
      expect(adapter.id).not.toBe('')
      expect(adapter.displayName).not.toBe('')
      mount()
      expect(element.querySelector('[aria-label="Page text"]')).not.toBeNull()
    })

    it('returns the initial content unchanged from getContent, without calling onChange', () => {
      const session = mount()
      expect(session.getContent()).toEqual(contractContent())
      expect(onChange).not.toHaveBeenCalled()
      expect(checkNoteContent(session.getContent()).issues).toEqual([])
    })

    it('hands out copies, not its own state', () => {
      const session = mount()
      const content = session.getContent()
      content.blocks.length = 0
      expect(session.getContent().blocks).toHaveLength(7)
    })

    it('fixes duplicate and invalid block ids in the initial content', () => {
      const broken = contractContent()
      broken.blocks[1]!.id = broken.blocks[0]!.id
      broken.blocks[2]!.id = 'not-a-uuid'
      const result = mount({ content: broken }).getContent()
      expect(checkNoteContent(result).issues).toEqual([])
      expect(new Set(result.blocks.map((b) => b.id)).size).toBe(7)
      expect(result.blocks[0]!.id).toBe(id(1))
    })

    it('calls onChange with valid content when the user edits', () => {
      const session = mount()
      type(session, ' noted')
      expect(onChange).toHaveBeenCalled()
      const emitted = onChange.mock.calls.at(-1)![0]
      expect(checkNoteContent(emitted).issues).toEqual([])
      expect(emitted).toEqual(session.getContent())
      expect(noteContentToPlainText(emitted)).toContain('Closing words noted')
      expect(session.getState().canUndo).toBe(true)
    })

    it('keeps the ids of blocks the user did not restructure', () => {
      const session = mount()
      type(session, ' noted')
      expect(session.getContent().blocks.map((b) => b.id)).toEqual(contractContent().blocks.map((b) => b.id))
    })

    it('setContent replaces the content, clears undo and does not call onChange', () => {
      const session = mount()
      type(session, ' noted')
      onChange.mockClear()
      const replacement: NoteContent = { format: 'tg-note', version: 1, blocks: [{ id: id(50), type: 'paragraph', indent: 0, content: [{ text: 'Another page' }] }] }
      session.setContent(replacement)
      expect(onChange).not.toHaveBeenCalled()
      expect(session.getContent()).toEqual(replacement)
      expect(session.getState().canUndo).toBe(false)
      expect(session.getState().canRedo).toBe(false)
      expect(session.run({ type: 'undo' })).toBe(false)
    })

    it('reports state changes', () => {
      const session = mount()
      type(session, ' noted')
      expect(states.length).toBeGreaterThan(0)
      expect(states.at(-1)).toEqual(session.getState())
    })

    describe('commands', () => {
      it('setBlock changes the current block and undo/redo walk back and forth', () => {
        const session = mount()
        type(session, '!')
        expect(session.run({ type: 'setBlock', block: 'heading2' })).toBe(true)
        expect(last(session.getContent())).toMatchObject({ type: 'heading', level: 2, content: [{ text: 'Closing words!' }] })
        expect(session.getState().activeBlock).toBe('heading2')
        expect(session.run({ type: 'undo' })).toBe(true)
        expect(last(session.getContent())).toMatchObject({ type: 'paragraph' })
        expect(session.run({ type: 'redo' })).toBe(true)
        expect(last(session.getContent())).toMatchObject({ type: 'heading', level: 2 })
        expect(session.run({ type: 'redo' })).toBe(false)
      })

      it('setBlock can make bullets, numbered items and checks', () => {
        const session = mount()
        for (const [block, type] of [['bullet', 'bullet'], ['numbered', 'numbered'], ['check', 'check'], ['paragraph', 'paragraph']] as const) {
          expect(session.run({ type: 'setBlock', block })).toBe(true)
          expect(last(session.getContent()).type).toBe(type)
        }
      })

      it('indent and outdent stay within bounds', () => {
        const session = mount()
        expect(session.run({ type: 'outdent' })).toBe(false)
        expect(session.run({ type: 'indent' })).toBe(true)
        expect(last(session.getContent())).toMatchObject({ indent: 1 })
        expect(session.run({ type: 'outdent' })).toBe(true)
        expect(last(session.getContent())).toMatchObject({ indent: 0 })
        for (let i = 0; i < 6; i += 1) expect(session.run({ type: 'indent' })).toBe(true)
        expect(session.run({ type: 'indent' })).toBe(false)
      })

      it('inserts a divider and a reference after the current block', () => {
        const session = mount()
        expect(session.run({ type: 'insertDivider' })).toBe(true)
        expect(last(session.getContent()).type).toBe('divider')
        expect(session.run({ type: 'insertReference', target: { kind: 'task', id: id(200) } })).toBe(true)
        expect(last(session.getContent())).toMatchObject({ type: 'reference', target: { kind: 'task', id: id(200) } })
        expect(session.getContent().blocks).toHaveLength(9)
        expect(checkNoteContent(session.getContent()).issues).toEqual([])
      })

      it('honors marks and links only if the adapter supports them, and says so', () => {
        const session = mount()
        driver.selectLastBlockText?.(session, element)
        expect(session.run({ type: 'toggleMark', mark: 'bold' })).toBe(driver.supportsMarks)
        expect(session.run({ type: 'setLink', href: 'https://example.org' })).toBe(driver.supportsMarks)
        if (driver.supportsMarks) {
          expect(last(session.getContent())).toMatchObject({ content: [{ marks: ['bold'], href: 'https://example.org' }] })
          expect(session.run({ type: 'toggleMark', mark: 'bold' })).toBe(true)
          expect(session.run({ type: 'setLink', href: null })).toBe(true)
          expect(last(session.getContent())).toMatchObject({ content: [{ text: 'Closing words' }] })
          expect(session.run({ type: 'setLink', href: 'javascript:alert(1)' })).toBe(false)
        }
        expect(checkNoteContent(session.getContent()).issues).toEqual([])
      })

      it('returns false instead of throwing for what it cannot do', () => {
        const session = mount()
        session.run({ type: 'insertDivider' }) // the caret block is now a divider
        driver.selectDivider?.(session, element)
        expect(session.run({ type: 'setBlock', block: 'heading1' })).toBe(false)
        expect(session.run({ type: 'indent' })).toBe(false)
      })
    })

    describe('read-only', () => {
      it('refuses commands while not editable and resumes when editable again', () => {
        const session = mount({ editable: false })
        expect(session.run({ type: 'insertDivider' })).toBe(false)
        expect(session.run({ type: 'setBlock', block: 'bullet' })).toBe(false)
        expect(session.getContent()).toEqual(contractContent())
        session.setEditable(true)
        expect(session.run({ type: 'insertDivider' })).toBe(true)
        session.setEditable(false)
        expect(session.run({ type: 'insertDivider' })).toBe(false)
        expect(session.getContent().blocks).toHaveLength(8)
      })
    })

    describe('destroy', () => {
      it('empties the element and refuses further commands', () => {
        const session = mount()
        expect(element.childNodes.length).toBeGreaterThan(0)
        session.destroy()
        expect(element.childNodes.length).toBe(0)
        expect(session.run({ type: 'insertDivider' })).toBe(false)
        expect(() => session.destroy()).not.toThrow()
        expect(onChange).not.toHaveBeenCalled()
      })
    })
  })
}
