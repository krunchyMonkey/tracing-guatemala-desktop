import {
  canonicalRuns,
  isSafeHref,
  normalizeNoteContent,
  type NoteBlock,
  type NoteContent,
  type TextRun
} from '../../../src/shared/note-content'
import type { BlockKind, EditorCommand, EditorState, RichTextEditorAdapter, RichTextEditorOptions, RichTextEditorSession } from '../../../src/renderer/src/notebook/ports'

// An in-memory editor double: no DOM editing, full contract. Tests drive "user edits"
// with type() / emit() and read what the app asked for from `commands`.

type TextBlock = Extract<NoteBlock, { content: TextRun[] }>
const hasText = (block: NoteBlock): block is TextBlock => 'content' in block

export interface FakeEditorSession extends RichTextEditorSession {
  readonly options: RichTextEditorOptions
  /** Every command passed to run(), honored or not. */
  readonly commands: EditorCommand[]
  /** Simulates the user typing at the end of the current block. */
  type(text: string): void
  /** Simulates the user replacing the whole document. */
  emit(content: NoteContent): void
  /** Moves the caret to a block (default: the last one). */
  select(blockIndex: number): void
}

export interface FakeEditorAdapter extends RichTextEditorAdapter {
  readonly sessions: FakeEditorSession[]
}

function withKind(block: TextBlock, kind: BlockKind): NoteBlock {
  const indent = block.type === 'heading' ? 0 : block.indent
  const content = block.content
  switch (kind) {
    case 'heading1':
      return { id: block.id, type: 'heading', level: 1, content }
    case 'heading2':
      return { id: block.id, type: 'heading', level: 2, content }
    case 'heading3':
      return { id: block.id, type: 'heading', level: 3, content }
    case 'check':
      return { id: block.id, type: 'check', indent, checked: false, content }
    default:
      return { id: block.id, type: kind, indent, content }
  }
}

export function createFakeEditorAdapter(id = 'fake'): FakeEditorAdapter {
  const sessions: FakeEditorSession[] = []
  return {
    id,
    displayName: 'Fake editor',
    sessions,
    create(options) {
      let content = normalizeNoteContent(options.content, options.newId)
      let editable = options.editable
      let caret: number | null = null
      let destroyed = false
      let past: NoteContent[] = []
      let future: NoteContent[] = []
      const commands: EditorCommand[] = []
      const marker = document.createElement('div')
      marker.setAttribute('data-fake-editor', '')
      marker.setAttribute('aria-label', options.label)
      options.element.replaceChildren(marker)

      const at = (): number => Math.min(caret ?? content.blocks.length - 1, content.blocks.length - 1)
      const state = (): EditorState => {
        const block = content.blocks[at()]
        const kind = block && hasText(block) ? (block.type === 'heading' ? (`heading${block.level}` as BlockKind) : (block.type as BlockKind)) : null
        const marks = block && hasText(block) && block.content.length > 0 ? (block.content[0]!.marks ?? []) : []
        return { canUndo: past.length > 0, canRedo: future.length > 0, activeMarks: [...marks], activeBlock: kind, selectedText: '', focused: false }
      }
      const report = (): void => {
        options.onChange(normalizeNoteContent(content, options.newId))
        options.onStateChange?.(state())
      }
      const edit = (blocks: NoteBlock[]): void => {
        past.push(content)
        future = []
        content = normalizeNoteContent({ ...content, blocks }, options.newId)
        report()
      }

      const session: FakeEditorSession = {
        options,
        commands,
        getContent: () => normalizeNoteContent(content, options.newId),
        setContent(next) {
          content = normalizeNoteContent(next, options.newId)
          past = []
          future = []
          caret = null
        },
        setEditable(next) {
          editable = next
        },
        focus() {},
        getState: state,
        type(text) {
          const blocks = [...content.blocks]
          let index = at()
          if (index < 0 || !hasText(blocks[index]!)) {
            blocks.push({ id: options.newId(), type: 'paragraph', indent: 0, content: [] })
            index = blocks.length - 1
          }
          const block = blocks[index] as TextBlock
          blocks[index] = { ...block, content: canonicalRuns([...block.content, { text }]) }
          edit(blocks)
        },
        emit(next) {
          content = normalizeNoteContent(next, options.newId)
          report()
        },
        select(index) {
          caret = index
        },
        run(command) {
          commands.push(command)
          if (destroyed || !editable) return false
          if (command.type === 'undo' || command.type === 'redo') {
            const [from, to] = command.type === 'undo' ? [past, future] : [future, past]
            const target = from.pop()
            if (!target) return false
            to.push(content)
            content = target
            report()
            return true
          }
          const blocks = [...content.blocks]
          const index = at()
          const block = blocks[index]
          switch (command.type) {
            case 'insertDivider':
              blocks.splice(index + 1, 0, { id: options.newId(), type: 'divider' })
              break
            case 'insertReference':
              blocks.splice(index + 1, 0, { id: options.newId(), type: 'reference', target: { ...command.target } })
              break
            case 'setBlock':
              if (!block || !hasText(block)) return false
              blocks[index] = withKind(block, command.block)
              break
            case 'indent':
            case 'outdent': {
              if (!block || !hasText(block) || block.type === 'heading') return false
              const indent = block.indent + (command.type === 'indent' ? 1 : -1)
              if (indent < 0 || indent > 6) return false
              blocks[index] = { ...block, indent }
              break
            }
            case 'toggleMark': {
              if (!block || !hasText(block) || block.content.length === 0) return false
              const all = block.content.every((r) => r.marks?.includes(command.mark))
              const runs = block.content.map((r) => ({
                ...r,
                marks: all ? (r.marks ?? []).filter((m) => m !== command.mark) : [...(r.marks ?? []), command.mark]
              }))
              blocks[index] = { ...block, content: runs }
              break
            }
            case 'setLink': {
              if (!block || !hasText(block) || block.content.length === 0) return false
              if (command.href !== null && !isSafeHref(command.href)) return false
              const href = command.href ?? undefined
              blocks[index] = {
                ...block,
                content: block.content.map((r) => ({ text: r.text, ...(r.marks ? { marks: r.marks } : {}), ...(href ? { href } : {}) }))
              }
              break
            }
          }
          edit(blocks)
          return true
        },
        destroy() {
          destroyed = true
          options.element.replaceChildren()
        }
      }
      sessions.push(session)
      return session
    }
  }
}
