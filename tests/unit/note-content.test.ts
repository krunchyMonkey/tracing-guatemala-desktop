import { describe, expect, it } from 'vitest'
import {
  canonicalRuns,
  checkNoteContent,
  emptyNoteContent,
  INLINE_MARKS,
  NOTE_MAX_BLOCKS,
  NOTE_MAX_BLOCK_CHARS,
  NOTE_MAX_HREF,
  NOTE_MAX_RUNS_PER_BLOCK,
  NOTE_MAX_TOTAL_CHARS,
  NoteContentError,
  noteContentStats,
  noteContentToMarkdown,
  noteContentToPlainText,
  normalizeNoteContent,
  parseStoredNoteContent,
  serializeNoteContent,
  type NoteBlock,
  type NoteContent,
  type NoteContentIssueCode
} from '../../src/shared/note-content'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const doc = (...blocks: unknown[]): unknown => ({ format: 'tg-note', version: 1, blocks })
const para = (n: number, text: string, extra: object = {}): unknown => ({ id: id(n), type: 'paragraph', indent: 0, content: [{ text }], ...extra })
const codes = (raw: unknown): NoteContentIssueCode[] => checkNoteContent(raw).issues.map((i) => i.code)

// A fictional page covering every block and mark type.
function richDocument(): NoteContent {
  return {
    format: 'tg-note',
    version: 1,
    blocks: [
      { id: id(1), type: 'heading', level: 1, content: [{ text: 'Parish of San Rafael: baptisms' }] },
      {
        id: id(2),
        type: 'paragraph',
        indent: 0,
        content: [
          { text: 'Searched the ' },
          { text: 'baptism', marks: ['bold'] },
          { text: ' index, ' },
          { text: 'twice', marks: ['italic', 'underline'] },
          { text: ', see ' },
          { text: 'the finding aid', href: 'https://example.org/aid?id=7' },
          { text: '. Struck: ' },
          { text: 'wrong year', marks: ['strike'] },
          { text: ' and ' },
          { text: 'Libro 3', marks: ['code'] },
          { text: '.\nSecond line,\tafter a tab.' }
        ]
      },
      { id: id(3), type: 'heading', level: 2, content: [{ text: 'Next steps' }] },
      { id: id(4), type: 'bullet', indent: 0, content: [{ text: 'Ask the archivist' }] },
      { id: id(5), type: 'bullet', indent: 1, content: [{ text: 'Email', marks: ['bold', 'italic'], href: 'mailto:archive@example.org' }] },
      { id: id(6), type: 'numbered', indent: 0, content: [{ text: 'First' }] },
      { id: id(7), type: 'numbered', indent: 0, content: [{ text: 'Second' }] },
      { id: id(8), type: 'check', indent: 0, checked: false, content: [{ text: 'Order the microfilm' }] },
      { id: id(9), type: 'check', indent: 1, checked: true, content: [{ text: 'Photograph the page' }] },
      { id: id(10), type: 'divider' },
      { id: id(11), type: 'heading', level: 3, content: [{ text: 'Linked records' }] },
      { id: id(12), type: 'reference', target: { kind: 'journal', id: id(100) } },
      { id: id(13), type: 'reference', target: { kind: 'task', id: id(101) } },
      { id: id(14), type: 'reference', target: { kind: 'time', id: id(102) } }
    ]
  }
}

describe('checkNoteContent', () => {
  it('accepts the empty document and a rich one, returning a copy', () => {
    expect(checkNoteContent(emptyNoteContent()).content).toEqual(emptyNoteContent())
    const rich = richDocument()
    const result = checkNoteContent(rich)
    expect(result.issues).toEqual([])
    expect(result.content).toEqual(rich)
    expect(result.content).not.toBe(rich)
  })

  it.each<[string, unknown, NoteContentIssueCode]>([
    ['not an object', 'text', 'invalid-structure'],
    ['an array', [], 'invalid-structure'],
    ['an unknown top-level key', { ...(emptyNoteContent() as object), extra: 1 }, 'invalid-structure'],
    ['a wrong format', { format: 'other', version: 1, blocks: [] }, 'unsupported-format'],
    ['a wrong version', { format: 'tg-note', version: 2, blocks: [] }, 'unsupported-version'],
    ['blocks that are not a list', { format: 'tg-note', version: 1, blocks: {} }, 'invalid-structure'],
    ['an unknown block type', doc({ id: id(1), type: 'table' }), 'unknown-block-type'],
    ['a block that is not an object', doc('x'), 'invalid-structure'],
    ['an unknown block key', doc(para(1, 'a', { style: 'x' })), 'invalid-structure'],
    ['a missing block key', doc({ id: id(1), type: 'paragraph', content: [] }), 'invalid-structure'],
    ['a bad uuid', doc(para(1, 'a', { id: 'not-a-uuid' })), 'invalid-id'],
    ['an uppercase uuid', doc(para(1, 'a', { id: id(1).replace('8000', '800A').toUpperCase() })), 'invalid-id'],
    ['a duplicate id', doc(para(1, 'a'), para(1, 'b')), 'duplicate-id'],
    ['a fractional indent', doc(para(1, 'a', { indent: 0.5 })), 'invalid-indent'],
    ['a too-deep indent', doc(para(1, 'a', { indent: 7 })), 'invalid-indent'],
    ['a bad heading level', doc({ id: id(1), type: 'heading', level: 4, content: [] }), 'invalid-level'],
    ['a non-boolean checked', doc({ id: id(1), type: 'check', indent: 0, checked: 'yes', content: [] }), 'invalid-structure'],
    ['an unknown mark', doc(para(1, 'a', { content: [{ text: 'a', marks: ['blink'] }] })), 'invalid-mark'],
    ['an unknown run key', doc(para(1, 'a', { content: [{ text: 'a', color: 'red' }] })), 'invalid-structure'],
    ['a control character', doc(para(1, 'a\u0000b')), 'invalid-characters'],
    ['a carriage return', doc(para(1, 'a\rb')), 'invalid-characters'],
    ['a javascript: link', doc(para(1, 'a', { content: [{ text: 'a', href: 'javascript:alert(1)' }] })), 'invalid-href'],
    ['a data: link', doc(para(1, 'a', { content: [{ text: 'a', href: 'data:text/html,hi' }] })), 'invalid-href'],
    ['a relative link', doc(para(1, 'a', { content: [{ text: 'a', href: '/x' }] })), 'invalid-href'],
    ['a link with a space', doc(para(1, 'a', { content: [{ text: 'a', href: 'https://example.org/a b' }] })), 'invalid-href'],
    ['a bad reference kind', doc({ id: id(1), type: 'reference', target: { kind: 'client', id: id(2) } }), 'invalid-reference'],
    ['a bad reference id', doc({ id: id(1), type: 'reference', target: { kind: 'task', id: 'x' } }), 'invalid-reference'],
    ['a reference with a copy of text', doc({ id: id(1), type: 'reference', target: { kind: 'task', id: id(2), text: 'copy' } }), 'invalid-reference']
  ])('rejects %s', (_name, raw, code) => {
    const result = checkNoteContent(raw)
    expect(result.content).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(code)
  })

  it('accepts http, https and mailto links and tab and hard break characters', () => {
    for (const href of ['http://example.org', 'HTTPS://example.org/a?b=c#d', 'mailto:a@example.org']) {
      expect(codes(doc(para(1, 'a\n\tb', { content: [{ text: 'a\n\tb', href }] })))).toEqual([])
    }
  })

  describe('limits', () => {
    it('rejects too many blocks', () => {
      const blocks = Array.from({ length: NOTE_MAX_BLOCKS + 1 }, (_, i) => para(i + 1, ''))
      expect(codes(doc(...blocks))).toEqual(['too-many-blocks'])
    })
    it('accepts the maximum number of blocks', () => {
      const blocks = Array.from({ length: NOTE_MAX_BLOCKS }, (_, i) => para(i + 1, 'x'))
      expect(codes(doc(...blocks))).toEqual([])
    })
    it('rejects too many runs in a block', () => {
      const content = Array.from({ length: NOTE_MAX_RUNS_PER_BLOCK + 1 }, () => ({ text: 'a' }))
      expect(codes(doc(para(1, '', { content })))).toEqual(['too-many-runs'])
    })
    it('rejects too much text in a block, and reports where', () => {
      const result = checkNoteContent(doc(para(1, 'a'), para(2, 'x'.repeat(NOTE_MAX_BLOCK_CHARS + 1))))
      expect(result.issues).toEqual([{ code: 'text-too-long', blockIndex: 1 }])
      expect(codes(doc(para(1, 'x'.repeat(NOTE_MAX_BLOCK_CHARS))))).toEqual([])
    })
    it('rejects too much text overall', () => {
      const perBlock = NOTE_MAX_BLOCK_CHARS
      const count = NOTE_MAX_TOTAL_CHARS / perBlock + 1
      const blocks = Array.from({ length: count }, (_, i) => para(i + 1, 'x'.repeat(perBlock)))
      expect(codes(doc(...blocks))).toEqual(['content-too-long'])
    })
    it('rejects an over-long link', () => {
      const href = `https://example.org/${'a'.repeat(NOTE_MAX_HREF)}`
      expect(codes(doc(para(1, 'a', { content: [{ text: 'a', href }] })))).toEqual(['href-too-long'])
    })
  })

  it('never echoes submitted text in an issue', () => {
    const secret = 'Maria Lopez 1888 secret'
    const result = checkNoteContent(doc(para(1, `${secret}\u0000`, { id: 'bad', extra: secret })))
    expect(JSON.stringify(result.issues)).not.toContain('Maria')
    expect(Object.keys(result.issues[0]!).sort()).toEqual(['blockIndex', 'code'])
  })
})

describe('canonical form', () => {
  it('deduplicates and orders marks, drops empty marks, hrefs and runs, merges neighbours', () => {
    const result = checkNoteContent(
      doc(
        para(1, '', {
          content: [
            { text: 'a', marks: ['italic', 'bold', 'italic'] },
            { text: 'b', marks: ['bold', 'italic'] },
            { text: '' },
            { text: 'c', marks: [] },
            { text: 'd' },
            { text: 'e', href: 'https://example.org' },
            { text: 'f', href: 'https://example.org' }
          ]
        })
      )
    )
    expect(result.content?.blocks[0]).toEqual({
      id: id(1),
      type: 'paragraph',
      indent: 0,
      content: [
        { text: 'ab', marks: ['bold', 'italic'] },
        { text: 'cd' },
        { text: 'ef', href: 'https://example.org' }
      ]
    })
    expect(INLINE_MARKS).toEqual(['bold', 'italic', 'underline', 'strike', 'code'])
  })

  it('canonicalRuns does not merge runs that differ in link or marks', () => {
    expect(canonicalRuns([{ text: 'a', href: 'https://example.org' }, { text: 'b' }, { text: 'c', marks: ['code'] }])).toHaveLength(3)
  })
})

describe('normalizeNoteContent', () => {
  it('keeps the first occurrence of an id and replaces missing, invalid and repeated ids', () => {
    let next = 1000
    const newId = (): string => id(next++)
    const blocks = [
      { id: id(1), type: 'divider' },
      { id: id(1), type: 'divider' },
      { id: 'nope', type: 'divider' },
      { type: 'divider' },
      { id: id(2), type: 'divider' }
    ] as NoteBlock[]
    const result = normalizeNoteContent({ format: 'tg-note', version: 1, blocks }, newId)
    expect(result.blocks.map((b) => b.id)).toEqual([id(1), id(1000), id(1001), id(1002), id(2)])
  })

  it('does not enforce limits, and canonicalizes runs', () => {
    const big = 'x'.repeat(NOTE_MAX_BLOCK_CHARS + 5)
    const result = normalizeNoteContent(
      { format: 'tg-note', version: 1, blocks: [{ id: id(1), type: 'paragraph', indent: 0, content: [{ text: big }, { text: '' }] }] },
      () => id(9)
    )
    expect(noteContentStats(result)).toEqual({ blocks: 1, characters: big.length })
    expect(result.blocks[0]).toMatchObject({ content: [{ text: big }] })
  })

  it('gives up if the id source keeps repeating itself', () => {
    const blocks = [{ id: id(1), type: 'divider' }, { id: id(1), type: 'divider' }] as NoteBlock[]
    expect(() => normalizeNoteContent({ format: 'tg-note', version: 1, blocks }, () => id(1))).toThrow(NoteContentError)
  })
})

describe('storage', () => {
  it('round-trips a rich document through serialize and parse', () => {
    const rich = richDocument()
    const json = serializeNoteContent(rich)
    expect(parseStoredNoteContent(json)).toEqual(rich)
    expect(serializeNoteContent(parseStoredNoteContent(json))).toBe(json)
  })

  it('writes keys in a stable order whatever order the input used', () => {
    const shuffled = { blocks: [{ content: [{ href: 'https://example.org', marks: ['bold'], text: 'a' }], indent: 0, type: 'paragraph', id: id(1) }], version: 1, format: 'tg-note' } as unknown as NoteContent
    expect(serializeNoteContent(shuffled)).toBe(
      `{"format":"tg-note","version":1,"blocks":[{"id":"${id(1)}","type":"paragraph","indent":0,"content":[{"text":"a","marks":["bold"],"href":"https://example.org"}]}]}`
    )
  })

  it('upgrades older versions through the upgrader table', () => {
    // A made-up v0 that stored plain strings; the table maps it to v1.
    const v0 = JSON.stringify({ format: 'tg-note', version: 0, paragraphs: [{ id: id(1), text: 'Old page' }] })
    const table = {
      0: (raw: unknown) => {
        const old = raw as { paragraphs: { id: string; text: string }[] }
        return { format: 'tg-note', version: 1, blocks: old.paragraphs.map((p) => ({ id: p.id, type: 'paragraph', indent: 0, content: [{ text: p.text }] })) }
      }
    }
    expect(parseStoredNoteContent(v0, table).blocks).toEqual([{ id: id(1), type: 'paragraph', indent: 0, content: [{ text: 'Old page' }] }])
    expect(() => parseStoredNoteContent(v0)).toThrow(expect.objectContaining({ code: 'unreadable' }))
    expect(() => parseStoredNoteContent(v0, { 0: (raw) => raw })).toThrow(expect.objectContaining({ code: 'unreadable' }))
  })

  it('rejects a newer version without echoing content', () => {
    const json = JSON.stringify({ format: 'tg-note', version: 99, blocks: [para(1, 'Private words')] })
    try {
      parseStoredNoteContent(json)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(NoteContentError)
      expect((error as NoteContentError).code).toBe('too-new')
      expect((error as Error).message).not.toContain('Private')
    }
  })

  it.each([
    ['not json', '{nope'],
    ['not an object', '[]'],
    ['another format', JSON.stringify({ format: 'x', version: 1, blocks: [] })],
    ['a bad version', JSON.stringify({ format: 'tg-note', version: 'one', blocks: [] })],
    ['a negative version', JSON.stringify({ format: 'tg-note', version: -1, blocks: [] })]
  ])('treats %s as unreadable', (_name, json) => {
    expect(() => parseStoredNoteContent(json)).toThrow(expect.objectContaining({ code: 'unreadable' }))
  })

  it('treats a structurally invalid current document as invalid', () => {
    const json = JSON.stringify(doc({ id: id(1), type: 'table' }))
    expect(() => parseStoredNoteContent(json)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
})

describe('export', () => {
  it('writes plain text', () => {
    expect(noteContentToPlainText(richDocument())).toMatchInlineSnapshot(`
      "Parish of San Rafael: baptisms

      Searched the baptism index, twice, see the finding aid. Struck: wrong year and Libro 3.
      Second line,	after a tab.

      Next steps

      - Ask the archivist
        - Email
      1. First
      2. Second
      [ ] Order the microfilm
        [x] Photograph the page

      ---

      Linked records

      [Journal entry]

      [Task]

      [Research hours entry]
      "
    `)
  })

  it('writes Markdown', () => {
    expect(noteContentToMarkdown(richDocument())).toMatchInlineSnapshot(`
      "# Parish of San Rafael: baptisms

      Searched the **baptism** index, *twice*, see [the finding aid](https://example.org/aid?id=7). Struck: ~~wrong year~~ and \`Libro 3\`.  
      Second line,	after a tab.

      ## Next steps

      - Ask the archivist
        - [***Email***](mailto:archive@example.org)
      1. First
      2. Second
      - [ ] Order the microfilm
        - [x] Photograph the page

      ---

      ### Linked records

      [Journal entry]

      [Task]

      [Research hours entry]
      "
    `)
  })

  it('uses the describe() label for references', () => {
    const content: NoteContent = { format: 'tg-note', version: 1, blocks: [{ id: id(1), type: 'reference', target: { kind: 'task', id: id(2) } }] }
    expect(noteContentToPlainText(content, (ref) => `Task ${ref.id.slice(-2)} [done]`)).toBe('[Task 02 [done]]\n')
    expect(noteContentToMarkdown(content, (ref) => `Task ${ref.id.slice(-2)} [done]`)).toBe('[Task 02 \\[done\\]]\n')
  })

  it('keeps HTML-looking text inert', () => {
    const content: NoteContent = {
      format: 'tg-note',
      version: 1,
      blocks: [{ id: id(1), type: 'paragraph', indent: 0, content: [{ text: '<img src=x onerror=alert(1)>' }] }]
    }
    expect(noteContentToMarkdown(content)).toBe('\\<img src=x onerror=alert(1)\\>\n')
    expect(noteContentToPlainText(content)).toBe('<img src=x onerror=alert(1)>\n')
  })

  it('escapes Markdown that would otherwise change meaning', () => {
    const content: NoteContent = {
      format: 'tg-note',
      version: 1,
      blocks: [
        { id: id(1), type: 'paragraph', indent: 0, content: [{ text: '# not a heading *or* [link](x) `tick`' }] },
        { id: id(2), type: 'paragraph', indent: 0, content: [{ text: '1. not a list' }] },
        { id: id(3), type: 'paragraph', indent: 0, content: [{ text: 'a `b` c', marks: ['code'] }] }
      ]
    }
    expect(noteContentToMarkdown(content)).toBe('\\# not a heading \\*or\\* \\[link\\](x) \\`tick\\`\n\n1\\. not a list\n\n`` a `b` c ``\n')
  })

  it('encodes characters in a link target that would end the link', () => {
    const content: NoteContent = {
      format: 'tg-note',
      version: 1,
      blocks: [{ id: id(1), type: 'paragraph', indent: 0, content: [{ text: ' go ', href: 'https://example.org/a_(b)' }] }]
    }
    expect(noteContentToMarkdown(content)).toBe(' [go](https://example.org/a_%28b%29) \n')
  })

  it('exports nothing for an empty page', () => {
    expect(noteContentToMarkdown(emptyNoteContent())).toBe('')
    expect(noteContentToPlainText(emptyNoteContent())).toBe('')
  })

  it('counts blocks and characters', () => {
    expect(noteContentStats(emptyNoteContent())).toEqual({ blocks: 0, characters: 0 })
    expect(noteContentStats(richDocument()).blocks).toBe(14)
    expect(noteContentStats({ format: 'tg-note', version: 1, blocks: [{ id: id(1), type: 'divider' }, { id: id(2), type: 'paragraph', indent: 0, content: [{ text: 'abc' }] }] })).toEqual({ blocks: 2, characters: 3 })
  })
})
