import {
  canonicalRuns,
  INLINE_MARKS,
  isNoteBlockId,
  isSafeHref,
  NOTE_MAX_INDENT,
  normalizeNoteContent,
  type InlineMark,
  type NoteBlock,
  type NoteContent,
  type RecordKind,
  type TextRun
} from '../../../../../shared/note-content'

// Pure mapping between the app's flat block list (tg-note/1) and a ProseMirror
// document in JSON form. No library imports: the shapes below are plain data, so this
// file is unit-tested without a DOM. The editor's own document is never stored.
//
// Nesting: a bullet/numbered/check run becomes nested lists by `indent`. The first
// block of a run is at depth 0 and a block can be at most one level deeper than the
// one before it, so odd stored indents (0, then 3) come back one level at a time
// (a normalization of structure, never of text). A list item's extra paragraphs
// (the editor allows them) flatten to paragraph blocks at the item's indent.

export interface PmNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

/** Nodes that carry a stable `blockId` (and so become one block each). */
export const BLOCK_ID_NODES = ['paragraph', 'heading', 'listItem', 'taskItem', 'horizontalRule', 'noteReference'] as const

const LIST_NODE = { bullet: 'bulletList', numbered: 'orderedList', check: 'taskList' } as const
const ITEM_NODE = { bullet: 'listItem', numbered: 'listItem', check: 'taskItem' } as const
type ListKind = keyof typeof LIST_NODE
type ListBlock = Extract<NoteBlock, { type: ListKind }>

const isListBlock = (block: NoteBlock): block is ListBlock => block.type === 'bullet' || block.type === 'numbered' || block.type === 'check'
const isListNode = (node: PmNode): boolean => node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList'
const RECORD_KINDS: readonly string[] = ['journal', 'task', 'time']
/** Any control character except the hard break and tab, which the content format forbids. */
const BAD_CHARS = /[^\P{Cc}\n\t]/gu

// ---------- NoteContent -> ProseMirror ----------

function inlineNodes(runs: TextRun[]): PmNode[] {
  const out: PmNode[] = []
  for (const run of runs) {
    const marks: NonNullable<PmNode['marks']> = (run.marks ?? []).map((type) => ({ type }))
    if (run.href && isSafeHref(run.href)) marks.push({ type: 'link', attrs: { href: run.href } })
    const withMarks = marks.length > 0 ? { marks } : {}
    run.text.split('\n').forEach((part, i) => {
      if (i > 0) out.push({ type: 'hardBreak', ...withMarks })
      if (part !== '') out.push({ type: 'text', text: part, ...withMarks })
    })
  }
  return out
}

function textNode(type: 'paragraph' | 'heading', runs: TextRun[], attrs?: Record<string, unknown>): PmNode {
  const content = inlineNodes(runs)
  return { type, ...(attrs ? { attrs } : {}), ...(content.length > 0 ? { content } : {}) }
}

function simpleNode(block: NoteBlock): PmNode {
  switch (block.type) {
    case 'paragraph':
      return textNode('paragraph', block.content, { blockId: block.id, indent: block.indent })
    case 'heading':
      return textNode('heading', block.content, { level: block.level, blockId: block.id })
    case 'divider':
      return { type: 'horizontalRule', attrs: { blockId: block.id } }
    case 'reference':
      return { type: 'noteReference', attrs: { kind: block.target.kind, id: block.target.id, blockId: block.id } }
    default:
      throw new Error('Not a simple block')
  }
}

type Item = { block: ListBlock; depth: number }

/** One nested list level of `items`, starting at `from`; returns the lists and where it stopped. */
function buildLevel(items: Item[], from: number, depth: number): { nodes: PmNode[]; next: number } {
  const lists: PmNode[] = []
  let i = from
  while (i < items.length && items[i]!.depth >= depth) {
    const kind = items[i]!.block.type
    const listItems: PmNode[] = []
    while (i < items.length && items[i]!.depth === depth && items[i]!.block.type === kind) {
      const { block } = items[i]!
      i += 1
      const children: PmNode[] = [textNode('paragraph', block.content)]
      if (i < items.length && items[i]!.depth > depth) {
        const nested = buildLevel(items, i, depth + 1)
        children.push(...nested.nodes)
        i = nested.next
      }
      const attrs: Record<string, unknown> = { blockId: block.id }
      if (block.type === 'check') attrs['checked'] = block.checked
      listItems.push({ type: ITEM_NODE[kind], attrs, content: children })
    }
    lists.push({ type: LIST_NODE[kind], content: listItems })
  }
  return { nodes: lists, next: i }
}

/** The ProseMirror document (JSON) for `content`. An empty page becomes one empty paragraph. */
export function toProseMirror(content: NoteContent): PmNode {
  const nodes: PmNode[] = []
  const { blocks } = content
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]!
    if (!isListBlock(block)) {
      nodes.push(simpleNode(block))
      i += 1
      continue
    }
    const items: Item[] = []
    while (i < blocks.length && isListBlock(blocks[i]!)) {
      const item = blocks[i] as ListBlock
      const previous = items[items.length - 1]
      items.push({ block: item, depth: Math.min(item.indent, previous ? previous.depth + 1 : 0) })
      i += 1
    }
    nodes.push(...buildLevel(items, 0, 0).nodes)
  }
  if (nodes.length === 0) nodes.push({ type: 'paragraph' })
  return { type: 'doc', content: nodes }
}

// ---------- ProseMirror -> NoteContent ----------

function runsOf(node: PmNode | undefined): TextRun[] {
  const runs: TextRun[] = []
  for (const child of node?.content ?? []) {
    let text: string
    if (child.type === 'text') text = (child.text ?? '').replace(BAD_CHARS, '')
    else if (child.type === 'hardBreak') text = '\n'
    else continue
    const marks: InlineMark[] = []
    let href: string | undefined
    for (const mark of child.marks ?? []) {
      if ((INLINE_MARKS as readonly string[]).includes(mark.type)) marks.push(mark.type as InlineMark)
      else if (mark.type === 'link') {
        const candidate = mark.attrs?.['href']
        if (typeof candidate === 'string' && isSafeHref(candidate)) href = candidate
      }
    }
    runs.push({ text, ...(marks.length > 0 ? { marks } : {}), ...(href ? { href } : {}) })
  }
  return canonicalRuns(runs)
}

const idOf = (node: PmNode): string => {
  const id = node.attrs?.['blockId']
  return typeof id === 'string' && isNoteBlockId(id) ? id : ''
}

const clampIndent = (value: number): number => Math.max(0, Math.min(NOTE_MAX_INDENT, Math.trunc(value)))

/** A block for a non-list node, or null for anything the format cannot hold. `indent` applies to paragraphs only. */
function simpleBlock(node: PmNode, indent: number | null): NoteBlock | null {
  switch (node.type) {
    case 'paragraph': {
      const stored = node.attrs?.['indent']
      const own = typeof stored === 'number' ? stored : 0
      return { id: idOf(node), type: 'paragraph', indent: clampIndent(indent ?? own), content: runsOf(node) }
    }
    case 'heading': {
      const level = node.attrs?.['level']
      return { id: idOf(node), type: 'heading', level: level === 1 || level === 2 ? level : 3, content: runsOf(node) }
    }
    case 'horizontalRule':
      return { id: idOf(node), type: 'divider' }
    case 'noteReference': {
      const kind = node.attrs?.['kind']
      const id = node.attrs?.['id']
      if (typeof kind !== 'string' || !RECORD_KINDS.includes(kind) || typeof id !== 'string' || !isNoteBlockId(id)) return null
      return { id: idOf(node), type: 'reference', target: { kind: kind as RecordKind, id } }
    }
    default:
      return null
  }
}

function flattenList(list: PmNode, depth: number, out: NoteBlock[]): void {
  const type: ListKind = list.type === 'orderedList' ? 'numbered' : list.type === 'taskList' ? 'check' : 'bullet'
  const indent = clampIndent(depth)
  for (const item of list.content ?? []) {
    const [first, ...rest] = item.content ?? []
    const id = idOf(item)
    const content = runsOf(first)
    out.push(type === 'check' ? { id, type, indent, checked: item.attrs?.['checked'] === true, content } : { id, type, indent, content })
    for (const child of rest) {
      if (isListNode(child)) flattenList(child, depth + 1, out)
      else {
        const block = simpleBlock(child, depth)
        if (block) out.push(block)
      }
    }
  }
}

/**
 * NoteContent for a ProseMirror document (JSON). Ids the editor has not assigned yet are
 * made with `newId`; trailing empty paragraphs (the editor keeps one to type into) are dropped.
 */
export function fromProseMirror(doc: PmNode, newId: () => string): NoteContent {
  const blocks: NoteBlock[] = []
  for (const node of doc.content ?? []) {
    if (isListNode(node)) flattenList(node, 0, blocks)
    else {
      const block = simpleBlock(node, null)
      if (block) blocks.push(block)
    }
  }
  for (let tail = blocks[blocks.length - 1]; tail && tail.type === 'paragraph' && tail.indent === 0 && tail.content.length === 0; tail = blocks[blocks.length - 1]) {
    blocks.pop()
  }
  return normalizeNoteContent({ format: 'tg-note', version: 1, blocks }, newId)
}
