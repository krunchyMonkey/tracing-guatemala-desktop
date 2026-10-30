// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { NotebookAdaptersProvider, useNotebookAdapters, type NotebookAdapters } from '../../../src/renderer/src/notebook/NotebookAdapters'
import { defaultNotebookAdapters } from '../../../src/renderer/src/notebook/adapters'
import { plainTextAdapter } from '../../../src/renderer/src/notebook/adapters/plain/plainTextAdapter'
import { noteContentStats, type NoteContent } from '../../../src/shared/note-content'
import { contractContent, describeEditorAdapterContract, type EditorContractDriver } from './editorAdapterContract'
import { createFakeCanvasAdapter } from './fakeCanvasAdapter'
import { createFakeEditorAdapter, type FakeEditorSession } from './fakeEditorAdapter'

const plainDriver: EditorContractDriver = {
  supportsMarks: false,
  simulateTyping(_session, element, text) {
    const textarea = element.querySelector('textarea')!
    textarea.value += text
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

const fakeDriver: EditorContractDriver = {
  supportsMarks: true,
  simulateTyping: (session, _element, text) => (session as FakeEditorSession).type(text)
}

// The same contract, two interchangeable providers.
describeEditorAdapterContract('plain text', () => plainTextAdapter, plainDriver)
describeEditorAdapterContract('in-memory fake', () => createFakeEditorAdapter(), fakeDriver)

// Component code that only knows the provider seam: it never changes between adapters.
function PageText({ content }: { content: NoteContent }) {
  const { editor } = useNotebookAdapters()
  const host = useRef<HTMLDivElement>(null)
  const [stats, setStats] = useState(noteContentStats(content))
  useEffect(() => {
    let n = 0
    const session = editor.create({
      element: host.current!,
      content,
      editable: true,
      label: 'Page text',
      newId: () => `00000000-0000-4000-8000-${String(900 + n++).padStart(12, '0')}`,
      onChange: (next) => setStats(noteContentStats(next))
    })
    return () => session.destroy()
  }, [editor, content])
  return (
    <section>
      <h2>{editor.displayName}</h2>
      <div ref={host} />
      <output aria-label="Characters">{stats.characters}</output>
    </section>
  )
}

describe('swapping the editor provider', () => {
  afterEach(cleanup)
  const content = contractContent()
  const baseline = noteContentStats(content).characters

  it('renders the same component with the plain adapter', () => {
    const adapters: NotebookAdapters = { editor: plainTextAdapter, canvas: null }
    render(
      <NotebookAdaptersProvider adapters={adapters}>
        <PageText content={content} />
      </NotebookAdaptersProvider>
    )
    expect(screen.getByRole('heading', { name: 'Plain text (basic)' })).toBeTruthy()
    const box = screen.getByLabelText('Page text') as HTMLTextAreaElement
    expect(box.value).toContain('# Parish of San Rafael')
    expect(screen.getByLabelText('Characters').textContent).toBe(String(baseline))
    fireEvent.input(box, { target: { value: `${box.value} more` } })
    expect(screen.getByLabelText('Characters').textContent).toBe(String(baseline + 5))
  })

  it('renders the same component with the fake adapter', () => {
    const fake = createFakeEditorAdapter()
    render(
      <NotebookAdaptersProvider adapters={{ editor: fake, canvas: createFakeCanvasAdapter() }}>
        <PageText content={content} />
      </NotebookAdaptersProvider>
    )
    expect(screen.getByRole('heading', { name: 'Fake editor' })).toBeTruthy()
    expect(screen.getByLabelText('Characters').textContent).toBe(String(baseline))
    act(() => fake.sessions[0]!.type(' more'))
    expect(screen.getByLabelText('Characters').textContent).toBe(String(baseline + 5))
  })

  it('has a plain editor and no canvas by default, and refuses to run without a provider', () => {
    expect(defaultNotebookAdapters.editor).toBe(plainTextAdapter)
    expect(defaultNotebookAdapters.canvas).toBeNull()
    expect(() => render(<PageText content={content} />)).toThrow(/NotebookAdaptersProvider/)
  })
})
