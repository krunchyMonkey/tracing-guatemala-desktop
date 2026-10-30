import { describe, expect, it } from 'vitest'
import { fromProseMirror, toProseMirror, type PmNode } from '../../src/renderer/src/notebook/adapters/tiptap/mapping'
import { checkNoteContent, type NoteBlock, type NoteContent } from '../../src/shared/note-content'

// The pure mapping between tg-note/1 blocks and the editor's document (JSON).

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let spare = 900
const newId = (): string => id(spare++)
const content = (...blocks: NoteBlock[]): NoteContent => ({ format: 'tg-note', version: 1, blocks })
const roundTrip = (c: NoteContent): NoteContent => fromProseMirror(toProseMirror(c), newId)
const text = (value: string): PmNode => ({ type: 'text', text: value })

describe('tiptap mapping', () => {
  it('round-trips every block and mark type', () => {
    const c = content(
      { id: id(1), type: 'heading', level: 1, content: [{ text: 'Title' }] },
      { id: id(2), type: 'heading', level: 3, content: [{ text: 'Third' }] },
      {
        id: id(3),
        type: 'paragraph',
        indent: 2,
        content: [
          { text: 'plain ' },
          { text: 'b', marks: ['bold'] },
          { text: 'i', marks: ['italic'] },
          { text: 'u', marks: ['underline'] },
          { text: 's', marks: ['strike'] },
          { text: 'c', marks: ['code'] },
          { text: 'bi', marks: ['bold', 'italic'] },
          { text: 'link', href: 'https://example.org/a' },
          { text: 'bold link', marks: ['bold'], href: 'mailto:person@example.org' }
        ]
      },
      { id: id(4), type: 'paragraph', indent: 0, content: [{ text: 'one\ntwo\tthree' }] },
      { id: id(5), type: 'bullet', indent: 0, content: [{ text: 'a' }] },
      { id: id(6), type: 'bullet', indent: 1, content: [{ text: 'a.1' }] },
      { id: id(7), type: 'numbered', indent: 2, content: [{ text: 'deep' }] },
      { id: id(8), type: 'bullet', indent: 0, content: [{ text: 'b' }] },
      { id: id(9), type: 'numbered', indent: 0, content: [{ text: 'n1' }] },
      { id: id(10), type: 'numbered', indent: 0, content: [{ text: 'n2' }] },
      { id: id(11), type: 'check', indent: 0, checked: true, content: [{ text: 'done' }] },
      { id: id(12), type: 'check', indent: 1, checked: false, content: [{ text: 'todo' }] },
      { id: id(13), type: 'divider' },
      { id: id(14), type: 'reference', target: { kind: 'time', id: id(100) } },
      { id: id(15), type: 'paragraph', indent: 0, content: [{ text: 'End' }] }
    )
    const back = roundTrip(c)
    expect(back).toEqual(c)
    expect(checkNoteContent(back).issues).toEqual([])
  })

  it('nests lists by indent and starts a new list when the kind changes', () => {
    const doc = toProseMirror(
      content(
        { id: id(1), type: 'bullet', indent: 0, content: [{ text: 'a' }] },
        { id: id(2), type: 'check', indent: 1, checked: false, content: [{ text: 'a1' }] },
        { id: id(3), type: 'numbered', indent: 0, content: [{ text: 'n' }] }
      )
    )
    expect(doc.content!.map((n) => n.type)).toEqual(['bulletList', 'orderedList'])
    const item = doc.content![0]!.content![0]!
    expect(item.type).toBe('listItem')
    expect(item.content!.map((n) => n.type)).toEqual(['paragraph', 'taskList'])
    expect(item.content![1]!.content![0]!.attrs).toMatchObject({ checked: false, blockId: id(2) })
  })

  it('brings a skipped indent back one level at a time, keeping the text', () => {
    const back = roundTrip(
      content(
        { id: id(1), type: 'bullet', indent: 3, content: [{ text: 'first' }] },
        { id: id(2), type: 'bullet', indent: 5, content: [{ text: 'second' }] }
      )
    )
    expect(back.blocks.map((b) => ('indent' in b ? b.indent : -1))).toEqual([0, 1])
    expect(back.blocks.map((b) => ('content' in b ? b.content[0]!.text : ''))).toEqual(['first', 'second'])
  })

  it('flattens extra paragraphs of a list item to paragraph blocks at its indent', () => {
    const child: PmNode = { type: 'bulletList', content: [{ type: 'listItem', attrs: { blockId: id(3) }, content: [{ type: 'paragraph', content: [text('child')] }] }] }
    const doc: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { blockId: id(1) },
              content: [
                { type: 'paragraph', content: [text('item')] },
                { type: 'paragraph', attrs: { blockId: id(2) }, content: [text('more')] },
                child,
                { type: 'paragraph', attrs: { blockId: id(4) }, content: [text('after child')] }
              ]
            }
          ]
        }
      ]
    }
    expect(fromProseMirror(doc, newId).blocks.map((b) => [b.type, 'indent' in b ? b.indent : null])).toEqual([
      ['bullet', 0],
      ['paragraph', 0],
      ['bullet', 1],
      ['paragraph', 0]
    ])
  })

  it('maps an empty page to one empty paragraph and back to no blocks', () => {
    const doc = toProseMirror(content())
    expect(doc.content).toEqual([{ type: 'paragraph' }])
    expect(fromProseMirror(doc, newId).blocks).toEqual([])
  })

  it('drops trailing empty paragraphs but keeps empty ones in between', () => {
    const back = fromProseMirror(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { blockId: id(1) }, content: [text('a')] },
          { type: 'paragraph', attrs: { blockId: id(2) } },
          { type: 'paragraph', attrs: { blockId: id(3) }, content: [text('b')] },
          { type: 'horizontalRule', attrs: { blockId: id(4) } },
          { type: 'paragraph', attrs: { blockId: id(5) } }
        ]
      },
      newId
    )
    expect(back.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'divider'])
  })

  it('repairs missing and duplicate ids; the first holder keeps its id', () => {
    const back = fromProseMirror(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { blockId: id(1) }, content: [text('a')] },
          { type: 'paragraph', attrs: { blockId: id(1) }, content: [text('b')] },
          { type: 'paragraph', attrs: { blockId: null }, content: [text('c')] },
          { type: 'paragraph', attrs: { blockId: 'not-a-uuid' }, content: [text('d')] }
        ]
      },
      newId
    )
    expect(back.blocks[0]!.id).toBe(id(1))
    expect(new Set(back.blocks.map((b) => b.id)).size).toBe(4)
    expect(checkNoteContent(back).issues).toEqual([])
  })

  it('keeps only what the format can hold: unsafe links, unknown marks, control characters, bad references', () => {
    const back = fromProseMirror(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { blockId: id(1) },
            content: [
              { type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'highlight' }] },
              text(' a\u0000b\u0007c')
            ]
          },
          { type: 'noteReference', attrs: { kind: 'journal', id: 'nope', blockId: id(2) } },
          { type: 'heading', attrs: { level: 5, blockId: id(3) }, content: [text('h')] },
          { type: 'image', attrs: { src: 'x' } }
        ]
      },
      newId
    )
    expect(back.blocks).toEqual([
      { id: id(1), type: 'paragraph', indent: 0, content: [{ text: 'click abc' }] },
      { id: id(3), type: 'heading', level: 3, content: [{ text: 'h' }] }
    ])
    expect(checkNoteContent(back).issues).toEqual([])
  })

  it('clamps indent to the format maximum', () => {
    const back = fromProseMirror({ type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: id(1), indent: 40 }, content: [text('x')] }] }, newId)
    expect(back.blocks[0]).toMatchObject({ indent: 6 })
  })
})
