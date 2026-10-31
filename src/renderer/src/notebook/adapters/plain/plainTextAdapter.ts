import { isNoteBlockId, NOTE_MAX_INDENT, normalizeNoteContent, type NoteBlock, type NoteContent, type RecordKind, type TextRun } from '../../../../../shared/note-content'
import type { BlockKind, EditorCommand, EditorState, RichTextEditorAdapter, RichTextEditorOptions, RichTextEditorSession } from '../../ports'

// A dependency-free editor: one <textarea>, one line per block. It is the default
// until a richer provider is added (docs/architecture/research-notebook.md), and a
// lossy fallback: inline marks and links cannot be typed or shown, and the commands
// toggleMark and setLink return false. A line the user does not touch keeps its
// block exactly as it was, marks included; an edited line becomes plain text.
//
// Line syntax: "# ", "## ", "### " headings; "- " bullets; "1. " numbered;
// "- [ ] " / "- [x] " checks; "---" divider; two leading spaces per indent level;
// "@ref:<journal|task|time>:<uuid>" for a record reference (kept opaque). A hard
// break inside a block shows as a space. Only value/textContent are used, never innerHTML.

const HISTORY_LIMIT = 200
const REFERENCE_LINE = /^@ref:(journal|task|time):(\S+)$/
const OTHER_CONTROL = /(?![\t])\p{Cc}/gu

type TextBlock = Extract<NoteBlock, { content: TextRun[] }>

const run = (text: string): TextRun[] => (text === '' ? [] : [{ text }])
const plainText = (runs: TextRun[]): string => runs.map((r) => r.text).join('').replace(/\n/g, ' ')

function blockKind(block: NoteBlock): BlockKind | null {
  switch (block.type) {
    case 'heading':
      return `heading${block.level}`
    case 'paragraph':
    case 'bullet':
    case 'numbered':
    case 'check':
      return block.type
    default:
      return null
  }
}

/** The textarea lines for `content`, numbering lists the way they are read back. */
function formatLines(content: NoteContent): string[] {
  const counters: number[] = []
  return content.blocks.map((block) => {
    if (block.type === 'numbered') {
      counters[block.indent] = (counters[block.indent] ?? 0) + 1
      counters.length = block.indent + 1
    } else if (block.type === 'bullet' || block.type === 'check') {
      counters.length = Math.min(counters.length, block.indent)
    } else {
      counters.length = 0
    }
    switch (block.type) {
      case 'paragraph':
        return '  '.repeat(block.indent) + plainText(block.content)
      case 'heading':
        return `${'#'.repeat(block.level)} ${plainText(block.content)}`
      case 'bullet':
        return `${'  '.repeat(block.indent)}- ${plainText(block.content)}`
      case 'numbered':
        return `${'  '.repeat(block.indent)}${counters[block.indent]}. ${plainText(block.content)}`
      case 'check':
        return `${'  '.repeat(block.indent)}- [${block.checked ? 'x' : ' '}] ${plainText(block.content)}`
      case 'divider':
        return '---'
      case 'reference':
        return `@ref:${block.target.kind}:${block.target.id}`
    }
  })
}

/** A block (with an empty id) for one line of text. */
function parseLine(rawLine: string): NoteBlock {
  const line = rawLine.replace(OTHER_CONTROL, '')
  const ref = REFERENCE_LINE.exec(line)
  if (ref && isNoteBlockId(ref[2])) return { id: '', type: 'reference', target: { kind: ref[1] as RecordKind, id: ref[2] } }
  if (line === '---') return { id: '', type: 'divider' }
  const spaces = /^ */.exec(line)![0].length
  const indent = Math.min(NOTE_MAX_INDENT, Math.floor(spaces / 2))
  const rest = line.slice(spaces)
  const heading = /^(#{1,3}) (.*)$/.exec(rest)
  if (heading) return { id: '', type: 'heading', level: heading[1]!.length as 1 | 2 | 3, content: run(heading[2]!) }
  const check = /^- \[( |x|X)\](?: (.*))?$/.exec(rest)
  if (check) return { id: '', type: 'check', indent, checked: check[1] !== ' ', content: run(check[2] ?? '') }
  const bullet = /^- (.*)$/.exec(rest)
  if (bullet) return { id: '', type: 'bullet', indent, content: run(bullet[1]!) }
  const numbered = /^\d+\. (.*)$/.exec(rest)
  if (numbered) return { id: '', type: 'numbered', indent, content: run(numbered[1]!) }
  return { id: '', type: 'paragraph', indent, content: run(rest) }
}

const sameKind = (a: NoteBlock, b: NoteBlock): boolean => a.type === b.type && (a.type !== 'heading' || (b.type === 'heading' && a.level === b.level))

const hasText = (block: NoteBlock): block is TextBlock => 'content' in block

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

function createSession(options: RichTextEditorOptions): RichTextEditorSession {
  const { element, label, newId } = options
  let current = normalizeNoteContent(options.content, newId)
  let editable = options.editable
  let destroyed = false
  let past: NoteContent[] = []
  let future: NoteContent[] = []
  let lastState: string | null = null

  const textarea = document.createElement('textarea')
  textarea.setAttribute('aria-label', label)
  if (options.placeholder) textarea.placeholder = options.placeholder
  textarea.readOnly = !editable
  textarea.spellcheck = true
  textarea.rows = 12
  textarea.style.width = '100%'
  textarea.style.boxSizing = 'border-box'
  textarea.value = formatLines(current).join('\n')
  element.replaceChildren(textarea)

  const snapshot = (): NoteContent => normalizeNoteContent(current, newId)
  const lineIndex = (): number => textarea.value.slice(0, textarea.selectionStart).split('\n').length - 1

  const getState = (): EditorState => {
    const block = current.blocks[lineIndex()]
    return {
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      activeMarks: [],
      activeBlock: block ? blockKind(block) : null,
      selectedText: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
      focused: document.activeElement === textarea
    }
  }
  const publishState = (): void => {
    if (!options.onStateChange || destroyed) return
    const state = getState()
    const key = JSON.stringify(state)
    if (key === lastState) return
    lastState = key
    options.onStateChange(state)
  }

  /** Reads the textarea back into blocks, keeping untouched lines and ids by position. */
  const readBlocks = (): NoteBlock[] => {
    if (textarea.value === '') return []
    const oldLines = formatLines(current)
    return textarea.value.split('\n').map((line, i) => {
      const old = current.blocks[i]
      if (old && oldLines[i] === line) return old
      const parsed = parseLine(line)
      return { ...parsed, id: old && sameKind(old, parsed) ? old.id : newId() }
    })
  }

  const remember = (): void => {
    past.push(current)
    if (past.length > HISTORY_LIMIT) past.shift()
    future = []
  }

  const showCaret = (line: number): void => {
    const lines = textarea.value.split('\n')
    const offset = lines.slice(0, line + 1).join('\n').length
    textarea.setSelectionRange(offset, offset)
  }

  /** Applies a command-made change: shows it, remembers it, reports it. */
  const commit = (blocks: NoteBlock[], caretLine: number): void => {
    remember()
    current = normalizeNoteContent({ ...current, blocks }, newId)
    textarea.value = formatLines(current).join('\n')
    showCaret(caretLine)
    options.onChange(snapshot())
    publishState()
  }

  const onInput = (): void => {
    if (!editable) return
    const blocks = readBlocks()
    remember()
    current = normalizeNoteContent({ ...current, blocks }, newId)
    options.onChange(snapshot())
    publishState()
  }
  const restore = (content: NoteContent): void => {
    current = content
    textarea.value = formatLines(current).join('\n')
    options.onChange(snapshot())
    publishState()
  }

  const listeners: [string, () => void][] = [
    ['input', onInput],
    ['keyup', publishState],
    ['mouseup', publishState],
    ['select', publishState],
    ['focus', publishState],
    ['blur', publishState]
  ]
  for (const [type, listener] of listeners) textarea.addEventListener(type, listener)

  return {
    getContent: () => snapshot(),
    setContent(content) {
      if (destroyed) return
      current = normalizeNoteContent(content, newId)
      past = []
      future = []
      textarea.value = formatLines(current).join('\n')
      publishState()
    },
    setEditable(next) {
      editable = next
      textarea.readOnly = !next
    },
    focus: () => textarea.focus(),
    // A reference shows as its opaque "@ref:" line here, so there is no label to refresh.
    refreshReferences() {},
    getState,
    run(command: EditorCommand): boolean {
      if (destroyed || !editable) return false
      const blocks = readBlocks()
      const at = Math.min(lineIndex(), Math.max(blocks.length - 1, 0))
      const block = blocks[at]
      switch (command.type) {
        case 'undo': {
          const previous = past.pop()
          if (!previous) return false
          future.push(current)
          restore(previous)
          return true
        }
        case 'redo': {
          const next = future.pop()
          if (!next) return false
          past.push(current)
          restore(next)
          return true
        }
        case 'setBlock':
          if (!block || !hasText(block)) return false
          blocks[at] = withKind(block, command.block)
          commit(blocks, at)
          return true
        case 'indent':
        case 'outdent': {
          if (!block || !hasText(block) || block.type === 'heading') return false
          const indent = block.indent + (command.type === 'indent' ? 1 : -1)
          if (indent < 0 || indent > NOTE_MAX_INDENT) return false
          blocks[at] = { ...block, indent }
          commit(blocks, at)
          return true
        }
        case 'insertDivider':
          blocks.splice(at + 1, 0, { id: newId(), type: 'divider' })
          commit(blocks, at + 1)
          return true
        case 'insertReference':
          blocks.splice(at + 1, 0, { id: newId(), type: 'reference', target: { ...command.target } })
          commit(blocks, at + 1)
          return true
        default:
          // toggleMark and setLink: this editor has no inline formatting.
          return false
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const [type, listener] of listeners) textarea.removeEventListener(type, listener)
      element.replaceChildren()
    }
  }
}

export const plainTextAdapter: RichTextEditorAdapter = {
  id: 'plain-text',
  displayName: 'Plain text (basic)',
  create: createSession
}
