import { Editor, type Extensions } from '@tiptap/core'
import { Bold } from '@tiptap/extension-bold'
import { Code } from '@tiptap/extension-code'
import { Document } from '@tiptap/extension-document'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Heading } from '@tiptap/extension-heading'
import { HorizontalRule } from '@tiptap/extension-horizontal-rule'
import { Italic } from '@tiptap/extension-italic'
import { Link } from '@tiptap/extension-link'
import { BulletList, ListItem, ListKeymap, OrderedList, TaskList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Strike } from '@tiptap/extension-strike'
import { Text } from '@tiptap/extension-text'
import { Underline } from '@tiptap/extension-underline'
import { Placeholder, TrailingNode, UndoRedo } from '@tiptap/extensions'
import { EditorState, NodeSelection, Selection } from '@tiptap/pm/state'
import { isSafeHref, NOTE_MAX_INDENT, normalizeNoteContent, type InlineMark, type NoteContent } from '../../../../../shared/note-content'
import type { BlockKind, EditorCommand, EditorState as NoteEditorState, RichTextEditorAdapter, RichTextEditorOptions, RichTextEditorSession } from '../../ports'
import { BlockId, DEFAULT_REFERENCE_LABELS, ENSURE_IDS_META, NoteReference, NoteTaskItem, ParagraphIndent } from './extensions'
import { fromProseMirror, toProseMirror } from './mapping'

// The rich-text editor behind the RichTextEditorAdapter port: vanilla Tiptap (no React
// binding) mounted into the given element. Extensions are listed one by one rather than
// through the starter kit so the versions stay exact. Content goes in and out through
// mapping.ts; the editor's document is never stored.
//
// CSP: production allows no inline <style> and no style="" attributes, so the editor is
// created with injectCSS: false (its base CSS is in styles.css) and nothing here
// renders a style attribute; indent is the class note-indent-N.
//
// Paste safety rests on the schema: HTML is parsed into the nodes and marks below and
// everything else (images, scripts, iframes, styles, event handlers, unknown attributes)
// is dropped. A link survives only if its address passes isSafeHref.

const MARK_COMMANDS: Record<InlineMark, 'toggleBold' | 'toggleItalic' | 'toggleUnderline' | 'toggleStrike' | 'toggleCode'> = {
  bold: 'toggleBold',
  italic: 'toggleItalic',
  underline: 'toggleUnderline',
  strike: 'toggleStrike',
  code: 'toggleCode'
}

const MARKS = Object.keys(MARK_COMMANDS) as InlineMark[]
const noPasteRules = { addPasteRules: () => [] }

/** Pasted text keeps the user's characters: typing `**x**` formats, pasting it does not. */
const Marks = [Bold, Italic, Underline, Strike].map((mark) => mark.extend(noPasteRules))

// The format allows code together with other marks.
const NoteCode = Code.extend({ excludes: '', ...noPasteRules })

const NoteLink = Link.extend({
  addAttributes() {
    // Only the address is kept; pasted target, rel, class and title are not.
    return { href: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute('href') } }
  }
})

// The schema already drops everything it does not know, so this is not what makes a paste
// safe. It keeps hostile markup from even being tried: parsing a pasted <img onerror=...>
// or style="..." attribute, even in a detached document, makes the browser report blocked
// inline handlers and styles under the production CSP. Only tags are touched; text stays.
const DROPPED_ELEMENTS = /<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi
const DROPPED_TAGS = /<(?:img|link|meta|base|source|video|audio|input)\b[^>]*>/gi
const ACTIVE_ATTRIBUTES = /\s(?:on[a-z]+|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi

export function quietPastedHtml(html: string): string {
  return html
    .replace(DROPPED_ELEMENTS, '')
    .replace(DROPPED_TAGS, '')
    .replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(ACTIVE_ATTRIBUTES, ''))
}

function buildExtensions(options: RichTextEditorOptions): Extensions {
  const describe = options.describeReference ?? ((ref) => DEFAULT_REFERENCE_LABELS[ref.kind])
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    HorizontalRule,
    Heading.configure({ levels: [1, 2, 3] }),
    ...Marks,
    NoteCode,
    NoteLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      isAllowedUri: (url) => isSafeHref(url),
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank', class: null }
    }),
    BulletList,
    OrderedList,
    ListItem,
    TaskList,
    NoteTaskItem.configure({ nested: true }),
    ListKeymap,
    UndoRedo,
    TrailingNode,
    Placeholder.configure({ placeholder: options.placeholder ?? '' }),
    BlockId.configure({ newId: options.newId }),
    ParagraphIndent,
    NoteReference.configure({ describe })
  ]
}

/** Test-only: lets a test place the selection and type without a browser. Nothing in the app uses it. */
export interface TiptapTestHandle {
  typeAtEnd(text: string): void
  selectLastBlockText(): void
  selectDivider(): void
}

export interface TiptapAdapterHooks {
  onSession?(handle: TiptapTestHandle, element: HTMLElement): void
}

function createSession(options: RichTextEditorOptions, hooks: TiptapAdapterHooks): RichTextEditorSession {
  const { element, newId } = options
  let silent = false
  let ready = false
  let destroyed = false
  let lastState: string | null = null
  let editable = options.editable

  element.replaceChildren()
  const editor = new Editor({
    element,
    extensions: buildExtensions(options),
    content: toProseMirror(normalizeNoteContent(options.content, newId)),
    editable,
    injectCSS: false,
    enableInputRules: true,
    enablePasteRules: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': options.label,
        ...(editable ? {} : { 'aria-readonly': 'true' }),
        spellcheck: 'true'
      },
      // A dropped file would otherwise make the browser leave the page to open it.
      transformPastedHTML: quietPastedHtml,
      handleDrop: (_view, event) => (event.dataTransfer?.files.length ?? 0) > 0
    },
    onUpdate: () => {
      if (!silent && !destroyed) options.onChange(getContent())
    },
    onTransaction: () => ready && publishState(),
    onSelectionUpdate: () => ready && publishState(),
    onFocus: () => ready && publishState(),
    onBlur: () => ready && publishState()
  })

  const getContent = (): NoteContent => fromProseMirror(editor.getJSON(), newId)

  function listDepth(): number {
    const { $from } = editor.state.selection
    let depth = 0
    for (let d = $from.depth; d > 0; d -= 1) {
      const name = $from.node(d).type.name
      if (name === 'bulletList' || name === 'orderedList' || name === 'taskList') depth += 1
    }
    return depth
  }

  /** The kind of the innermost list item holding the caret, or the plain block there. */
  function activeBlock(): BlockKind | null {
    const { $from } = editor.state.selection
    for (let d = $from.depth; d > 0; d -= 1) {
      const name = $from.node(d).type.name
      if (name === 'taskItem') return 'check'
      if (name === 'listItem') return $from.node(d - 1).type.name === 'orderedList' ? 'numbered' : 'bullet'
    }
    const parent = $from.parent
    if (parent.type.name === 'heading') return `heading${Math.min(3, Number(parent.attrs['level']))}` as BlockKind
    return parent.type.name === 'paragraph' ? 'paragraph' : null
  }

  const itemName = (): 'taskItem' | 'listItem' => (editor.isActive('taskItem') ? 'taskItem' : 'listItem')

  const getState = (): NoteEditorState => {
    const { from, to } = editor.state.selection
    return {
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
      activeMarks: MARKS.filter((mark) => editor.isActive(mark)),
      activeBlock: activeBlock(),
      selectedText: from === to ? '' : editor.state.doc.textBetween(from, to, '\n'),
      focused: editor.isFocused
    }
  }

  function publishState(): void {
    if (!options.onStateChange || destroyed) return
    const state = getState()
    const key = JSON.stringify(state)
    if (key === lastState) return
    lastState = key
    options.onStateChange(state)
  }

  /**
   * Gives ids to nodes that have none (a new empty paragraph, the trailing one) and puts the
   * caret at the end of the page, without reporting an edit.
   */
  function ensureIds(): void {
    silent = true
    try {
      const tr = editor.state.tr.setMeta(ENSURE_IDS_META, true).setMeta('addToHistory', false)
      editor.view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)))
    } finally {
      silent = false
    }
  }
  ensureIds()
  ready = true

  const onClick = (event: MouseEvent): void => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]')
    const href = anchor?.getAttribute('href')
    if (!href || !isSafeHref(href) || !(event.ctrlKey || event.metaKey || !editor.isEditable)) return
    event.preventDefault()
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  editor.view.dom.addEventListener('click', onClick)

  function setBlock(block: BlockKind): boolean {
    if (activeBlock() === block) return true
    const chain = () => editor.chain().focus()
    const inList = (): boolean => editor.isActive('listItem') || editor.isActive('taskItem')
    if (block === 'paragraph' || block.startsWith('heading')) {
      for (let guard = 0; inList() && guard < NOTE_MAX_INDENT + 2; guard += 1) {
        if (!chain().liftListItem(itemName()).run()) return false
      }
      return block === 'paragraph' ? chain().setParagraph().run() : chain().setHeading({ level: Number(block.slice(7)) as 1 | 2 | 3 }).run()
    }
    if (editor.isActive('heading')) chain().setParagraph().run()
    return block === 'bullet' ? chain().toggleBulletList().run() : block === 'numbered' ? chain().toggleOrderedList().run() : chain().toggleTaskList().run()
  }

  function shiftIndent(delta: 1 | -1): boolean {
    if (listDepth() > 0) {
      if (delta > 0) return listDepth() <= NOTE_MAX_INDENT && editor.chain().focus().sinkListItem(itemName()).run()
      return listDepth() > 1 && editor.chain().focus().liftListItem(itemName()).run()
    }
    return editor
      .chain()
      .focus()
      .command(({ tr, state }) => {
        let changed = false
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos, parent) => {
          if (node.type.name !== 'paragraph' || parent?.type.name !== 'doc') return
          const next = Number(node.attrs['indent']) + delta
          if (next < 0 || next > NOTE_MAX_INDENT) return
          tr.setNodeAttribute(pos, 'indent', next)
          changed = true
        })
        return changed
      })
      .run()
  }

  function setLink(href: string | null): boolean {
    if (href === null) return editor.chain().focus().extendMarkRange('link').unsetLink().run()
    if (!isSafeHref(href)) return false
    if (editor.state.selection.empty && !editor.isActive('link')) return false
    return editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }

  hooks.onSession?.(
    {
      typeAtEnd(text) {
        const { state, dispatch } = editor.view
        dispatch(state.tr.setSelection(Selection.atEnd(state.doc)).insertText(text))
      },
      selectLastBlockText() {
        const end = Selection.atEnd(editor.state.doc).$to
        editor.commands.setTextSelection({ from: end.start(), to: end.end() })
      },
      selectDivider() {
        let target = -1
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'horizontalRule') target = pos
        })
        if (target >= 0) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, target)))
      }
    },
    element
  )

  return {
    getContent,
    setContent(content) {
      if (destroyed) return
      const doc = editor.schema.nodeFromJSON(toProseMirror(normalizeNoteContent(content, newId)))
      // A fresh state starts a fresh undo history; nothing here is a user edit.
      silent = true
      try {
        editor.view.updateState(EditorState.create({ schema: editor.schema, doc, plugins: editor.state.plugins }))
      } finally {
        silent = false
      }
      ensureIds()
      lastState = null
      publishState()
    },
    setEditable(next) {
      editable = next
      editor.setEditable(next, false)
      if (next) editor.view.dom.removeAttribute('aria-readonly')
      else editor.view.dom.setAttribute('aria-readonly', 'true')
    },
    focus: () => {
      editor.commands.focus()
    },
    getState,
    run(command: EditorCommand): boolean {
      if (destroyed || !editable) return false
      switch (command.type) {
        case 'toggleMark':
          return editor.chain().focus()[MARK_COMMANDS[command.mark]]().run()
        case 'setBlock':
          return setBlock(command.block)
        case 'indent':
          return shiftIndent(1)
        case 'outdent':
          return shiftIndent(-1)
        case 'setLink':
          return setLink(command.href)
        case 'insertDivider':
          return editor.chain().focus().setHorizontalRule().run()
        case 'insertReference':
          return editor.chain().focus().insertContent({ type: 'noteReference', attrs: { kind: command.target.kind, id: command.target.id } }).run()
        case 'undo':
          return editor.chain().focus().undo().run()
        case 'redo':
          return editor.chain().focus().redo().run()
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      editor.view.dom.removeEventListener('click', onClick)
      editor.destroy()
      element.replaceChildren()
    }
  }
}

export const tiptapAdapter: RichTextEditorAdapter = {
  id: 'tiptap',
  displayName: 'Rich text (Tiptap)',
  create: (options) => createSession(options, {})
}

/** A new adapter; `hooks` is for tests. */
export function createTiptapAdapter(hooks: TiptapAdapterHooks = {}): RichTextEditorAdapter {
  return { id: tiptapAdapter.id, displayName: tiptapAdapter.displayName, create: (options) => createSession(options, hooks) }
}
