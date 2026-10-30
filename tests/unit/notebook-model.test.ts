import { describe, expect, it } from 'vitest'
import { checkNotebookTitle, compareByPosition, moveItem, PAGE_TITLE_MAX, SECTION_TITLE_MAX } from '../../src/shared/notebook'

describe('checkNotebookTitle', () => {
  it('trims and accepts a normal title', () => {
    expect(checkNotebookTitle('  Parish records  ', SECTION_TITLE_MAX)).toEqual({ title: 'Parish records', issues: [] })
  })

  it('requires a title', () => {
    expect(checkNotebookTitle('   ', PAGE_TITLE_MAX)).toEqual({ title: null, issues: [{ field: 'title', code: 'required' }] })
  })

  it('limits the length per kind of title', () => {
    expect(checkNotebookTitle('x'.repeat(SECTION_TITLE_MAX), SECTION_TITLE_MAX).issues).toEqual([])
    expect(checkNotebookTitle('x'.repeat(SECTION_TITLE_MAX + 1), SECTION_TITLE_MAX).issues).toEqual([{ field: 'title', code: 'too-long' }])
    expect(checkNotebookTitle('x'.repeat(SECTION_TITLE_MAX + 1), PAGE_TITLE_MAX).issues).toEqual([])
  })

  it('rejects control characters, including line breaks', () => {
    expect(checkNotebookTitle('a\nb', PAGE_TITLE_MAX).issues).toEqual([{ field: 'title', code: 'invalid-characters' }])
    expect(checkNotebookTitle('a\u0000', PAGE_TITLE_MAX).title).toBeNull()
  })

  it('never echoes the submitted title in an issue', () => {
    expect(JSON.stringify(checkNotebookTitle(`Maria\u0000`, PAGE_TITLE_MAX).issues)).not.toContain('Maria')
  })
})

describe('compareByPosition', () => {
  it('orders by position, then id', () => {
    const items = [
      { id: 'c', position: 2 },
      { id: 'b', position: 1 },
      { id: 'a', position: 2 }
    ]
    expect([...items].sort(compareByPosition).map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('moveItem', () => {
  const list = ['a', 'b', 'c', 'd']

  it('moves an item forward and backward without changing the input', () => {
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(list, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns an unchanged copy for the same or out-of-range positions', () => {
    for (const [from, to] of [[1, 1], [-1, 2], [0, 4], [0.5, 1], [4, 0]] as const) {
      const result = moveItem(list, from, to)
      expect(result).toEqual(list)
      expect(result).not.toBe(list)
    }
  })
})
