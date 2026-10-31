import { Extension, mergeAttributes, Node } from '@tiptap/core'
import { TaskItem } from '@tiptap/extension-list'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { isNoteBlockId, NOTE_MAX_INDENT, type RecordKind, type RecordRef } from '../../../../../shared/note-content'
import { BLOCK_ID_NODES } from './mapping'

// The few editor parts that are the app's own (everything else is stock Tiptap):
// stable block ids, paragraph indent as a CSS class, and the reference block.
// Nothing here renders a `style` attribute (the production CSP forbids them).

export const DEFAULT_REFERENCE_LABELS: Record<RecordKind, string> = {
  journal: 'Journal entry',
  task: 'Task',
  time: 'Research hours entry'
}

const ITEM_NODES = ['listItem', 'taskItem']
export const ENSURE_IDS_META = 'tg-ensure-block-ids'
const blockIdKey = new PluginKey('tgBlockIds')

/**
 * A `blockId` attribute on every block node (rendered as data-block-id) and a plugin that
 * gives a fresh id to any such node whose id is missing, invalid or already used earlier in
 * the document (after Enter splits a block, or a paste). The first holder of an id keeps it.
 * The first paragraph of a list item is part of the item and carries no id of its own.
 */
export const BlockId = Extension.create<{ newId: () => string }>({
  name: 'blockId',
  addOptions() {
    return { newId: () => { throw new Error('BlockId needs a newId.') } }
  },
  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_ID_NODES],
        attributes: {
          blockId: {
            default: null,
            // Pasted markup never brings ids (or anything else) along.
            parseHTML: () => null,
            renderHTML: (attributes) => (attributes['blockId'] ? { 'data-block-id': attributes['blockId'] } : {})
          }
        }
      }
    ]
  },
  addProseMirrorPlugins() {
    const { newId } = this.options
    return [
      new Plugin({
        key: blockIdKey,
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged || tr.getMeta(ENSURE_IDS_META))) return null
          const tr = state.tr
          const seen = new Set<string>()
          const fresh = (): string => {
            for (let attempt = 0; attempt < 8; attempt += 1) {
              const id = newId()
              if (isNoteBlockId(id) && !seen.has(id)) return id
            }
            throw new Error('Could not make a unique block id.')
          }
          state.doc.descendants((node, pos, parent, index) => {
            if (!(BLOCK_ID_NODES as readonly string[]).includes(node.type.name)) return
            const id: unknown = node.attrs['blockId']
            if (node.type.name === 'paragraph' && parent && ITEM_NODES.includes(parent.type.name) && index === 0) {
              if (id !== null) tr.setNodeAttribute(pos, 'blockId', null)
              return
            }
            if (typeof id === 'string' && isNoteBlockId(id) && !seen.has(id)) {
              seen.add(id)
              return
            }
            const next = fresh()
            seen.add(next)
            tr.setNodeAttribute(pos, 'blockId', next)
          })
          return tr.docChanged ? tr : null
        }
      })
    ]
  }
})

const INDENT_CLASS = /^note-indent-([1-6])$/

/** Paragraph indent (0-6) as the class note-indent-N, never as an inline style. */
export const ParagraphIndent = Extension.create({
  name: 'paragraphIndent',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const match = [...element.classList].map((name) => INDENT_CLASS.exec(name)).find(Boolean)
              return match ? Number(match[1]) : 0
            },
            renderHTML: (attributes) => {
              const indent = Number(attributes['indent'])
              return indent > 0 && indent <= NOTE_MAX_INDENT ? { class: `note-indent-${Math.trunc(indent)}` } : {}
            }
          }
        }
      }
    ]
  }
})

const RECORD_KIND_LIST: readonly string[] = ['journal', 'task', 'time']

/** A block that points at a journal entry, task or hours entry. It shows a label, never a copy. */
export interface NoteReferenceOptions {
  describe: (ref: RecordRef) => string
  /** Shown reference views register a function here that sets their label again (see refreshReferences). */
  views: Set<() => void>
  onActivate?: (ref: RecordRef) => void
}

export const NoteReference = Node.create<NoteReferenceOptions>({
  name: 'noteReference',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addOptions() {
    return { describe: (ref) => DEFAULT_REFERENCE_LABELS[ref.kind], views: new Set<() => void>() }
  },
  addAttributes() {
    return {
      kind: { default: 'journal' },
      id: { default: null }
    }
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-note-reference]',
        getAttrs: (element) => {
          const kind = element.getAttribute('data-note-reference')
          const id = element.getAttribute('data-ref-id')
          return kind && RECORD_KIND_LIST.includes(kind) && isNoteBlockId(id) ? { kind, id } : false
        }
      }
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'note-reference',
        'data-note-reference': node.attrs['kind'],
        'data-ref-id': node.attrs['id']
      }),
      this.options.describe(referenceOf(node.attrs))
    ]
  },
  addNodeView() {
    const { describe, views, onActivate } = this.options
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'note-reference'
      dom.contentEditable = 'false'
      // A link-like control: reachable by keyboard, activated by click or Enter.
      dom.tabIndex = 0
      dom.setAttribute('role', 'link')
      const ref = referenceOf(node.attrs)
      const activate = (event: Event) => {
        event.preventDefault()
        onActivate?.(ref)
      }
      dom.addEventListener('click', activate)
      dom.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') activate(event)
      })
      dom.setAttribute('data-note-reference', String(node.attrs['kind']))
      const blockId: unknown = node.attrs['blockId']
      if (typeof blockId === 'string') dom.setAttribute('data-block-id', blockId)
      const label = document.createElement('span')
      label.className = 'note-reference-label'
      // The label is the record's own text: shown as text only, never as markup.
      label.textContent = describe(ref)
      dom.append(label)
      const refresh = () => {
        label.textContent = describe(ref)
      }
      views.add(refresh)
      return {
        dom,
        stopEvent: (event) => event.type === 'click' || (event.type === 'keydown' && (event as KeyboardEvent).key === 'Enter'),
        destroy: () => {
          views.delete(refresh)
        }
      }
    }
  }
})

function referenceOf(attrs: Record<string, unknown>): RecordRef {
  const kind = RECORD_KIND_LIST.includes(String(attrs['kind'])) ? (attrs['kind'] as RecordKind) : 'journal'
  return { kind, id: String(attrs['id'] ?? '') }
}

/**
 * The checklist item. Tiptap's own view hides a label with an inline style (CSSOM
 * cssText), which shows up as a style attribute in the DOM; this one has none, and the
 * checkbox carries its own accessible name instead. A checkbox is a normal tab stop.
 */
export const NoteTaskItem = TaskItem.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const item = document.createElement('li')
      const wrapper = document.createElement('label')
      const checkbox = document.createElement('input')
      const content = document.createElement('div')
      item.setAttribute('data-type', 'taskItem')
      wrapper.contentEditable = 'false'
      checkbox.type = 'checkbox'
      // Clicking the box must not move the caret out of the text.
      checkbox.addEventListener('mousedown', (event) => event.preventDefault())
      checkbox.addEventListener('change', () => {
        const { checked } = checkbox
        if (!editor.isEditable || typeof getPos !== 'function') {
          checkbox.checked = !checked
          return
        }
        editor
          .chain()
          .focus(undefined, { scrollIntoView: false })
          .command(({ tr }) => {
            const position = getPos()
            const current = typeof position === 'number' ? tr.doc.nodeAt(position) : null
            if (typeof position !== 'number' || !current) return false
            tr.setNodeMarkup(position, undefined, { ...current.attrs, checked })
            return true
          })
          .run()
      })
      const sync = (current: typeof node): void => {
        const checked = current.attrs['checked'] === true
        item.setAttribute('data-checked', String(checked))
        checkbox.checked = checked
        checkbox.setAttribute('aria-label', `Task: ${current.textContent || 'empty task'}`)
        const blockId: unknown = current.attrs['blockId']
        if (typeof blockId === 'string') item.setAttribute('data-block-id', blockId)
        else item.removeAttribute('data-block-id')
      }
      sync(node)
      wrapper.append(checkbox)
      item.append(wrapper, content)
      return {
        dom: item,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== node.type) return false
          sync(updated)
          return true
        }
      }
    }
  }
})
