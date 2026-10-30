/* eslint-disable @typescript-eslint/no-explicit-any -- tests poke at untrusted-shaped data */
import { describe, expect, it } from 'vitest'
import {
  CANVAS_MAX_ELEMENTS,
  checkCanvasScene,
  CanvasSceneError,
  emptyCanvasScene,
  parseStoredCanvasScene,
  serializeCanvasScene,
  type CanvasIssueCode,
  type CanvasScene
} from '../../src/shared/notebook-canvas'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function scene(): CanvasScene {
  return {
    format: 'tg-canvas',
    version: 1,
    id: id(1),
    pageId: id(2),
    elements: [
      { id: id(10), blockId: id(100), x: 0, y: 0, width: 240, height: 80, z: 0 },
      { id: id(11), blockId: id(101), x: 300.5, y: -40, width: 200, height: 60, z: 1 }
    ],
    edges: [{ id: id(20), from: id(10), to: id(11) }],
    ink: [
      {
        id: id(30),
        strokes: [
          {
            id: id(31),
            tool: 'pen',
            color: '#1a2b3c',
            width: 2.5,
            points: [
              [0, 0, 0.5],
              [10, 12.5, 1]
            ]
          }
        ]
      }
    ]
  }
}

function mutate(change: (raw: any) => void): unknown {
  const raw: any = structuredClone(scene())
  change(raw)
  return raw
}

const codes = (raw: unknown): CanvasIssueCode[] => checkCanvasScene(raw).issues.map((i) => i.code)

describe('checkCanvasScene', () => {
  it('accepts a scene and an empty one', () => {
    expect(checkCanvasScene(scene())).toEqual({ scene: scene(), issues: [] })
    expect(checkCanvasScene(emptyCanvasScene(id(1), id(2))).issues).toEqual([])
  })

  it.each<[string, (raw: any) => void, CanvasIssueCode]>([
    ['an unknown key', (r) => (r.extra = 1), 'invalid-structure'],
    ['a wrong format', (r) => (r.format = 'x'), 'unsupported-format'],
    ['a wrong version', (r) => (r.version = 2), 'unsupported-version'],
    ['a bad page id', (r) => (r.pageId = 'p'), 'invalid-id'],
    ['an element with a text copy', (r) => (r.elements[0].text = 'copy'), 'invalid-structure'],
    ['an element without a block id', (r) => delete r.elements[0].blockId, 'invalid-structure'],
    ['a bad block id', (r) => (r.elements[0].blockId = 'x'), 'invalid-id'],
    ['a duplicate id', (r) => (r.elements[1].id = r.elements[0].id), 'duplicate-id'],
    ['a stroke id reusing an element id', (r) => (r.ink[0].strokes[0].id = r.elements[0].id), 'duplicate-id'],
    ['a non-finite number', (r) => (r.elements[0].x = NaN), 'invalid-number'],
    ['an out-of-range position', (r) => (r.elements[0].x = 1e9), 'out-of-bounds'],
    ['a zero width', (r) => (r.elements[0].width = 0), 'out-of-bounds'],
    ['an edge to a missing element', (r) => (r.edges[0].to = id(999)), 'unknown-endpoint'],
    ['an edge to the same element', (r) => (r.edges[0].to = r.edges[0].from), 'unknown-endpoint'],
    ['an edge pointing at a block id', (r) => (r.edges[0].to = id(101)), 'unknown-endpoint'],
    ['a bad colour', (r) => (r.ink[0].strokes[0].color = 'red'), 'invalid-color'],
    ['a bad tool', (r) => (r.ink[0].strokes[0].tool = 'brush'), 'invalid-tool'],
    ['pressure above 1', (r) => (r.ink[0].strokes[0].points[0][2] = 2), 'out-of-bounds'],
    ['a malformed point', (r) => (r.ink[0].strokes[0].points[0] = [1, 2]), 'invalid-structure'],
    ['an infinite point', (r) => (r.ink[0].strokes[0].points[0][0] = Infinity), 'invalid-number']
  ])('rejects %s', (_name, change, code) => {
    const raw = mutate(change)
    expect(codes(raw)).toContain(code)
    expect(checkCanvasScene(raw).scene).toBeNull()
  })

  it('rejects too many elements', () => {
    const raw = mutate((r) => {
      r.elements = Array.from({ length: CANVAS_MAX_ELEMENTS + 1 }, (_, i) => ({ id: id(1000 + i), blockId: id(5), x: 0, y: 0, width: 1, height: 1, z: 0 }))
      r.edges = []
    })
    expect(codes(raw)).toEqual(['too-many-elements'])
  })

  it('lowercases ink colours and reports only paths, never values', () => {
    const raw = mutate((r) => (r.ink[0].strokes[0].color = '#ABCDEF'))
    expect(checkCanvasScene(raw).scene?.ink[0]?.strokes[0]?.color).toBe('#abcdef')
    const bad = checkCanvasScene(mutate((r) => (r.ink[0].strokes[0].color = 'secret')))
    expect(JSON.stringify(bad.issues)).not.toContain('secret')
    expect(bad.issues[0]).toEqual({ code: 'invalid-color', path: 'ink[0].strokes[0]' })
  })

  it('references canonical blocks by id only', () => {
    const [element] = scene().elements
    expect(Object.keys(element!).sort()).toEqual(['blockId', 'height', 'id', 'width', 'x', 'y', 'z'])
  })
})

describe('canvas storage', () => {
  it('round-trips a scene', () => {
    const json = serializeCanvasScene(scene())
    expect(parseStoredCanvasScene(json)).toEqual(scene())
    expect(serializeCanvasScene(parseStoredCanvasScene(json))).toBe(json)
  })

  it('upgrades through the table, and rejects newer, unknown and invalid documents', () => {
    const v0 = JSON.stringify({ ...scene(), version: 0 })
    expect(parseStoredCanvasScene(v0, { 0: (raw) => ({ ...(raw as object), version: 1 }) })).toEqual(scene())
    expect(() => parseStoredCanvasScene(v0)).toThrow(expect.objectContaining({ code: 'unreadable' }))
    expect(() => parseStoredCanvasScene(JSON.stringify({ ...scene(), version: 9 }))).toThrow(expect.objectContaining({ code: 'too-new' }))
    expect(() => parseStoredCanvasScene('nope')).toThrow(CanvasSceneError)
    expect(() => parseStoredCanvasScene(JSON.stringify({ ...scene(), edges: [{ id: id(20), from: id(1), to: id(2) }] }))).toThrow(
      expect.objectContaining({ code: 'invalid' })
    )
  })
})
