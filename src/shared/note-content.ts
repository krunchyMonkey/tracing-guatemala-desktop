// Canonical research-notebook page content (tg-note/1, docs/architecture/research-notebook.md).
// The application owns this shape; an editor library only renders and edits it, so
// swapping the library never changes what is stored. Text is data, never HTML: no
// field holds markup and nothing here is ever rendered through innerHTML. Shared by
// the host (authoritative checks) and the browser (editors, export). No Node imports:
// the renderer bundles this file.

export const NOTE_FORMAT = 'tg-note'
export const NOTE_VERSION = 1

export const INLINE_MARKS = ['bold', 'italic', 'underline', 'strike', 'code'] as const
export type InlineMark = (typeof INLINE_MARKS)[number]

/** A stretch of text sharing the same marks and link. `href` is http:, https: or mailto: only. */
export interface TextRun {
  text: string
  marks?: InlineMark[]
  href?: string
}

export type RecordKind = 'journal' | 'task' | 'time'

/** A link to an existing case record. Never a copy of it. */
export interface RecordRef {
  kind: RecordKind
  id: string
}

export type NoteBlock =
  | { id: string; type: 'paragraph'; indent: number; content: TextRun[] }
  | { id: string; type: 'heading'; level: 1 | 2 | 3; content: TextRun[] }
  | { id: string; type: 'bullet'; indent: number; content: TextRun[] }
  | { id: string; type: 'numbered'; indent: number; content: TextRun[] }
  | { id: string; type: 'check'; indent: number; checked: boolean; content: TextRun[] }
  | { id: string; type: 'divider' }
  | { id: string; type: 'reference'; target: RecordRef }

export interface NoteContent {
  format: typeof NOTE_FORMAT
  version: 1
  blocks: NoteBlock[]
}

export const NOTE_MAX_BLOCKS = 5_000
export const NOTE_MAX_RUNS_PER_BLOCK = 500
export const NOTE_MAX_BLOCK_CHARS = 20_000
export const NOTE_MAX_TOTAL_CHARS = 200_000
export const NOTE_MAX_HREF = 2_048
export const NOTE_MAX_INDENT = 6

export type NoteContentIssueCode =
  | 'invalid-structure'
  | 'unsupported-format'
  | 'unsupported-version'
  | 'unknown-block-type'
  | 'invalid-id'
  | 'duplicate-id'
  | 'invalid-indent'
  | 'invalid-level'
  | 'invalid-mark'
  | 'invalid-href'
  | 'invalid-reference'
  | 'invalid-characters'
  | 'too-many-blocks'
  | 'too-many-runs'
  | 'text-too-long'
  | 'href-too-long'
  | 'content-too-long'

/** A rule outcome. Carries only a code and a block position, never the submitted text. */
export interface NoteContentIssue {
  code: NoteContentIssueCode
  blockIndex?: number
}

export interface NoteContentCheck {
  content: NoteContent | null
  issues: NoteContentIssue[]
}

const MAX_ISSUES = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** Any control character except the hard break and tab. */
const BAD_TEXT = /[^\P{Cc}\n\t]/u
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s\p{Cc}]+$/iu
const RECORD_KINDS: readonly string[] = ['journal', 'task', 'time']

const BLOCK_KEYS: Record<string, readonly string[]> = {
  paragraph: ['id', 'type', 'indent', 'content'],
  heading: ['id', 'type', 'level', 'content'],
  bullet: ['id', 'type', 'indent', 'content'],
  numbered: ['id', 'type', 'indent', 'content'],
  check: ['id', 'type', 'indent', 'checked', 'content'],
  divider: ['id', 'type'],
  reference: ['id', 'type', 'target']
}

export const emptyNoteContent = (): NoteContent => ({ format: NOTE_FORMAT, version: NOTE_VERSION, blocks: [] })

export const isNoteBlockId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

export const isSafeHref = (value: string): boolean => value.length <= NOTE_MAX_HREF && SAFE_HREF.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(value, key))

// --- Canonical form ---------------------------------------------------------

const canonicalMarks = (marks: readonly InlineMark[] | undefined): InlineMark[] =>
  INLINE_MARKS.filter((mark) => marks?.includes(mark))

/** Deduplicated, ordered marks; empty runs dropped; neighbours with equal marks and link merged. */
export function canonicalRuns(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const run of runs) {
    if (run.text === '') continue
    const marks = canonicalMarks(run.marks)
    const href = run.href ? run.href : undefined
    const previous = out[out.length - 1]
    if (previous && (previous.marks ?? []).join() === marks.join() && previous.href === href) {
      previous.text += run.text
      continue
    }
    const next: TextRun = { text: run.text }
    if (marks.length > 0) next.marks = marks
    if (href) next.href = href
    out.push(next)
  }
  return out
}

/** A copy of `block` with canonical key order and runs, under the given id. */
function orderBlock(block: NoteBlock, id: string): NoteBlock {
  switch (block.type) {
    case 'paragraph':
      return { id, type: 'paragraph', indent: block.indent, content: canonicalRuns(block.content) }
    case 'heading':
      return { id, type: 'heading', level: block.level, content: canonicalRuns(block.content) }
    case 'bullet':
      return { id, type: 'bullet', indent: block.indent, content: canonicalRuns(block.content) }
    case 'numbered':
      return { id, type: 'numbered', indent: block.indent, content: canonicalRuns(block.content) }
    case 'check':
      return { id, type: 'check', indent: block.indent, checked: block.checked, content: canonicalRuns(block.content) }
    case 'divider':
      return { id, type: 'divider' }
    case 'reference':
      return { id, type: 'reference', target: { kind: block.target.kind, id: block.target.id } }
  }
}

// --- Validation of untrusted input -------------------------------------------

/** Strictly validate untrusted content. On success `content` is a canonical copy. */
export function checkNoteContent(raw: unknown): NoteContentCheck {
  const issues: NoteContentIssue[] = []
  const add = (code: NoteContentIssueCode, blockIndex?: number): void => {
    if (issues.length < MAX_ISSUES) issues.push(blockIndex === undefined ? { code } : { code, blockIndex })
  }

  if (!isRecord(raw) || !hasOnlyKeys(raw, ['format', 'version', 'blocks'])) {
    add('invalid-structure')
    return { content: null, issues }
  }
  if (raw.format !== NOTE_FORMAT) add('unsupported-format')
  if (raw.version !== NOTE_VERSION) add('unsupported-version')
  const rawBlocks = raw.blocks
  if (!Array.isArray(rawBlocks)) add('invalid-structure')
  else if (rawBlocks.length > NOTE_MAX_BLOCKS) add('too-many-blocks')
  if (issues.length > 0 || !Array.isArray(rawBlocks)) return { content: null, issues }

  const seen = new Set<string>()
  const blocks: NoteBlock[] = []
  let totalChars = 0
  rawBlocks.forEach((rawBlock: unknown, index) => {
    const read = readBlock(rawBlock, index, add)
    totalChars += read.chars
    if (read.block === null) return
    if (seen.has(read.block.id)) add('duplicate-id', index)
    seen.add(read.block.id)
    blocks.push(read.block)
  })
  if (totalChars > NOTE_MAX_TOTAL_CHARS) add('content-too-long')

  if (issues.length > 0) return { content: null, issues }
  return { issues, content: { format: NOTE_FORMAT, version: NOTE_VERSION, blocks } }
}

type AddIssue = (code: NoteContentIssueCode, blockIndex?: number) => void

function readBlock(raw: unknown, index: number, add: AddIssue): { block: NoteBlock | null; chars: number } {
  if (!isRecord(raw)) {
    add('invalid-structure', index)
    return { block: null, chars: 0 }
  }
  const type = raw.type
  if (typeof type !== 'string' || !Object.hasOwn(BLOCK_KEYS, type)) {
    add('unknown-block-type', index)
    return { block: null, chars: 0 }
  }
  let ok = true
  const fail = (code: NoteContentIssueCode): void => {
    ok = false
    add(code, index)
  }
  if (!hasOnlyKeys(raw, BLOCK_KEYS[type]!)) fail('invalid-structure')
  if (!isNoteBlockId(raw.id)) fail('invalid-id')

  const indent = raw.indent
  if (BLOCK_KEYS[type]!.includes('indent')) {
    if (typeof indent !== 'number' || !Number.isInteger(indent) || indent < 0 || indent > NOTE_MAX_INDENT) fail('invalid-indent')
  }
  if (type === 'heading' && raw.level !== 1 && raw.level !== 2 && raw.level !== 3) fail('invalid-level')
  if (type === 'check' && typeof raw.checked !== 'boolean') fail('invalid-structure')

  let runs: TextRun[] = []
  let chars = 0
  if (BLOCK_KEYS[type]!.includes('content')) {
    const readRuns = readTextRuns(raw.content, fail)
    runs = readRuns.runs
    chars = readRuns.chars
  }

  let target: RecordRef | null = null
  if (type === 'reference') {
    const t = raw.target
    if (!isRecord(t) || !hasOnlyKeys(t, ['kind', 'id']) || typeof t.kind !== 'string' || !RECORD_KINDS.includes(t.kind) || !isNoteBlockId(t.id)) {
      fail('invalid-reference')
    } else {
      target = { kind: t.kind as RecordKind, id: t.id }
    }
  }
  if (!ok) return { block: null, chars }

  const id = raw.id as string
  const base = { id, indent: indent as number, content: runs }
  let block: NoteBlock
  switch (type) {
    case 'paragraph':
      block = { ...base, type: 'paragraph' }
      break
    case 'bullet':
      block = { ...base, type: 'bullet' }
      break
    case 'numbered':
      block = { ...base, type: 'numbered' }
      break
    case 'check':
      block = { ...base, type: 'check', checked: raw.checked as boolean }
      break
    case 'heading':
      block = { id, type: 'heading', level: raw.level as 1 | 2 | 3, content: runs }
      break
    case 'divider':
      block = { id, type: 'divider' }
      break
    default:
      block = { id, type: 'reference', target: target! }
  }
  return { block: orderBlock(block, id), chars }
}

function readTextRuns(raw: unknown, fail: (code: NoteContentIssueCode) => void): { runs: TextRun[]; chars: number } {
  if (!Array.isArray(raw)) {
    fail('invalid-structure')
    return { runs: [], chars: 0 }
  }
  if (raw.length > NOTE_MAX_RUNS_PER_BLOCK) {
    fail('too-many-runs')
    return { runs: [], chars: 0 }
  }
  const runs: TextRun[] = []
  let chars = 0
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item.text !== 'string' || !Object.keys(item).every((key) => key === 'text' || key === 'marks' || key === 'href')) {
      fail('invalid-structure')
      continue
    }
    chars += item.text.length
    if (BAD_TEXT.test(item.text)) fail('invalid-characters')
    const run: TextRun = { text: item.text }
    if (item.marks !== undefined) {
      if (!Array.isArray(item.marks) || !item.marks.every((m: unknown) => INLINE_MARKS.includes(m as InlineMark))) fail('invalid-mark')
      else run.marks = item.marks as InlineMark[]
    }
    if (item.href !== undefined) {
      if (typeof item.href !== 'string') fail('invalid-structure')
      else if (item.href.length > NOTE_MAX_HREF) fail('href-too-long')
      else if (!SAFE_HREF.test(item.href)) fail('invalid-href')
      else run.href = item.href
    }
    runs.push(run)
  }
  if (chars > NOTE_MAX_BLOCK_CHARS) fail('text-too-long')
  return { runs, chars }
}

// --- Editor-side normalization -------------------------------------------------

/**
 * For editors: fixes block ids (the first occurrence of an id keeps it; missing,
 * invalid and repeated ids get `newId()`) and canonicalizes runs. Does not enforce limits.
 */
export function normalizeNoteContent(content: NoteContent, newId: () => string): NoteContent {
  const seen = new Set<string>()
  const blocks = content.blocks.map((block) => {
    let id: unknown = block.id
    for (let attempt = 0; attempt < 8 && (!isNoteBlockId(id) || seen.has(id)); attempt += 1) id = newId()
    if (!isNoteBlockId(id) || seen.has(id)) throw new NoteContentError('invalid')
    seen.add(id)
    return orderBlock(block, id)
  })
  return { format: NOTE_FORMAT, version: NOTE_VERSION, blocks }
}

// --- Storage -------------------------------------------------------------------

export type NoteContentErrorCode = 'unreadable' | 'too-new' | 'invalid'

/** Thrown for stored content that cannot be used. The message never contains the content. */
export class NoteContentError extends Error {
  readonly code: NoteContentErrorCode
  constructor(code: NoteContentErrorCode) {
    super(
      code === 'too-new'
        ? 'Note content was written by a newer version of the app.'
        : code === 'invalid'
          ? 'Note content is not valid.'
          : 'Note content could not be read.'
    )
    this.name = 'NoteContentError'
    this.code = code
  }
}

export type NoteUpgraders = Record<number, (doc: unknown) => unknown>

/**
 * Forward-only upgraders, keyed by the version they upgrade FROM. Each returns a
 * document of a higher version. Empty while v1 is the only version; add `1: upgradeV1ToV2`
 * when NOTE_VERSION becomes 2.
 */
const upgraders: NoteUpgraders = {}

/** Stable JSON: canonical key order, canonical runs. */
export function serializeNoteContent(content: NoteContent): string {
  return JSON.stringify({
    format: NOTE_FORMAT,
    version: NOTE_VERSION,
    blocks: content.blocks.map((block) => orderBlock(block, block.id))
  })
}

/** Read stored JSON, upgrade older versions, and validate. `table` is a test seam. */
export function parseStoredNoteContent(json: string, table: NoteUpgraders = upgraders): NoteContent {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    throw new NoteContentError('unreadable')
  }
  const versionOf = (value: unknown): number => {
    const v = isRecord(value) ? value.version : undefined
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1
  }
  if (!isRecord(doc) || doc.format !== NOTE_FORMAT) throw new NoteContentError('unreadable')
  let version = versionOf(doc)
  if (version < 0) throw new NoteContentError('unreadable')
  if (version > NOTE_VERSION) throw new NoteContentError('too-new')
  while (version < NOTE_VERSION) {
    const upgrade = Object.hasOwn(table, version) ? table[version] : undefined
    if (!upgrade) throw new NoteContentError('unreadable')
    doc = upgrade(doc)
    const next = versionOf(doc)
    if (next <= version) throw new NoteContentError('unreadable')
    version = next
  }
  const { content } = checkNoteContent(doc)
  if (!content) throw new NoteContentError('invalid')
  return content
}

// --- Export ----------------------------------------------------------------------

export function noteContentStats(content: NoteContent): { blocks: number; characters: number } {
  let characters = 0
  for (const block of content.blocks) {
    if ('content' in block) for (const run of block.content) characters += run.text.length
  }
  return { blocks: content.blocks.length, characters }
}

const DEFAULT_REFERENCE_LABELS: Record<RecordKind, string> = {
  journal: 'Journal entry',
  task: 'Task',
  time: 'Research hours entry'
}

type DescribeReference = (ref: RecordRef) => string

export const noteContentToPlainText = (content: NoteContent, describe?: DescribeReference): string =>
  render(content, describe, false)

/**
 * Portable Markdown. Underline has no Markdown form and exports as plain text; paragraph
 * indent is dropped (indented paragraphs would turn into code blocks); text is escaped so
 * it can never become markup, including HTML-looking text.
 */
export const noteContentToMarkdown = (content: NoteContent, describe?: DescribeReference): string =>
  render(content, describe, true)

const isListBlock = (block: NoteBlock): boolean => block.type === 'bullet' || block.type === 'numbered' || block.type === 'check'

function render(content: NoteContent, describe: DescribeReference | undefined, markdown: boolean): string {
  const counters: number[] = []
  const lines: string[] = []
  content.blocks.forEach((block) => {
    if (block.type === 'numbered') {
      counters[block.indent] = (counters[block.indent] ?? 0) + 1
      counters.length = block.indent + 1
    } else if (block.type === 'bullet' || block.type === 'check') {
      counters.length = Math.min(counters.length, block.indent)
    } else {
      counters.length = 0
    }

    let prefix = ''
    let body = ''
    switch (block.type) {
      case 'paragraph':
        prefix = markdown ? '' : '  '.repeat(block.indent)
        body = runsText(block.content, markdown)
        break
      case 'heading':
        prefix = markdown ? `${'#'.repeat(block.level)} ` : ''
        body = runsText(block.content, markdown).replace(/\n/g, ' ')
        break
      case 'bullet':
        prefix = `${'  '.repeat(block.indent)}- `
        body = runsText(block.content, markdown)
        break
      case 'numbered':
        prefix = `${'  '.repeat(block.indent)}${counters[block.indent]}. `
        body = runsText(block.content, markdown)
        break
      case 'check':
        prefix = `${'  '.repeat(block.indent)}${markdown ? '- ' : ''}${block.checked ? '[x]' : '[ ]'} `
        body = runsText(block.content, markdown)
        break
      case 'divider':
        body = '---'
        break
      case 'reference':
        body = `[${markdown ? escapeInline(label(block.target, describe)) : label(block.target, describe)}]`
        break
    }
    const continuation = markdown ? `  \n${' '.repeat(prefix.length)}` : `\n${' '.repeat(prefix.length)}`
    lines.push((body === '' ? prefix.trimEnd() : prefix + body.replace(/\n/g, continuation)))
  })
  let out = ''
  content.blocks.forEach((block, index) => {
    if (index > 0) out += isListBlock(block) && isListBlock(content.blocks[index - 1]!) ? '\n' : '\n\n'
    out += lines[index]
  })
  return out === '' ? '' : `${out}\n`
}

const label = (ref: RecordRef, describe?: DescribeReference): string => describe?.(ref) ?? DEFAULT_REFERENCE_LABELS[ref.kind]

const escapeInline = (text: string): string => text.replace(/[\\`*_[\]<>~|&]/g, '\\$&')

function runsText(runs: TextRun[], markdown: boolean): string {
  if (!markdown) return runs.map((run) => run.text).join('')
  let lineStart = true
  let out = ''
  for (const run of runs) {
    const pieces = run.text.split('\n')
    out += pieces
      .map((piece, i) => {
        if (i > 0) lineStart = true
        const text = markdownPiece(piece, run, lineStart)
        if (piece.trim() !== '') lineStart = false
        return text
      })
      .join('\n')
  }
  return out
}

function markdownPiece(piece: string, run: TextRun, lineStart: boolean): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece)!
  const [, lead, core, trail] = match as unknown as [string, string, string, string]
  if (core === '') return piece
  const marks = run.marks ?? []
  let out: string
  if (marks.includes('code')) {
    const longest = Math.max(0, ...(core.match(/`+/g) ?? []).map((ticks) => ticks.length))
    const fence = '`'.repeat(longest + 1)
    out = longest > 0 ? `${fence} ${core} ${fence}` : `${fence}${core}${fence}`
  } else {
    out = escapeInline(core)
    if (lineStart) out = out.replace(/^(?:[#+=-]|(\d+)([.)]))/, (m, digits?: string, dot?: string) => (digits ? `${digits}\\${dot}` : `\\${m}`))
  }
  if (marks.includes('strike')) out = `~~${out}~~`
  if (marks.includes('italic')) out = `*${out}*`
  if (marks.includes('bold')) out = `**${out}**`
  if (run.href) out = `[${out}](${run.href.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`
  return lead + out + trail
}
