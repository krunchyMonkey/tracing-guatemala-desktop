// Canvas contract for Release B (tg-canvas/1, docs/architecture/research-notebook.md).
// Types and validation only: no canvas is built yet. A scene arranges references to
// canonical NoteBlocks (by id, never a text copy), links them with edges, and holds
// app-owned ink. If a provider ever needs its native scene state for full fidelity,
// that goes in a separately versioned adapter payload next to this, never in place of
// it. No Node imports: the renderer bundles this file.

import { isNoteBlockId } from './note-content'

export const CANVAS_FORMAT = 'tg-canvas'
export const CANVAS_VERSION = 1

/** Places the canonical block `blockId` on the canvas. Holds no text of its own. */
export interface CanvasElementRef {
  id: string
  blockId: string
  x: number
  y: number
  width: number
  height: number
  z: number
}

/** A connector between two element ids. */
export interface CanvasEdge {
  id: string
  from: string
  to: string
}

export interface InkStroke {
  id: string
  tool: 'pen' | 'highlighter'
  /** #rrggbb */
  color: string
  width: number
  /** x, y, pressure (0..1) */
  points: [number, number, number][]
}

export interface InkLayer {
  id: string
  strokes: InkStroke[]
}

export interface CanvasScene {
  format: typeof CANVAS_FORMAT
  version: 1
  id: string
  pageId: string
  elements: CanvasElementRef[]
  edges: CanvasEdge[]
  ink: InkLayer[]
}

export const CANVAS_MAX_ELEMENTS = 2_000
export const CANVAS_MAX_EDGES = 5_000
export const CANVAS_MAX_LAYERS = 50
export const CANVAS_MAX_STROKES = 5_000
export const CANVAS_MAX_POINTS_PER_STROKE = 5_000
export const CANVAS_MAX_POINTS = 200_000
export const CANVAS_COORDINATE_LIMIT = 1_000_000
export const CANVAS_SIZE_MAX = 100_000
export const CANVAS_STROKE_WIDTH_MAX = 200

export type CanvasIssueCode =
  | 'invalid-structure'
  | 'unsupported-format'
  | 'unsupported-version'
  | 'invalid-id'
  | 'duplicate-id'
  | 'invalid-number'
  | 'out-of-bounds'
  | 'invalid-color'
  | 'invalid-tool'
  | 'unknown-endpoint'
  | 'too-many-elements'
  | 'too-many-edges'
  | 'too-many-layers'
  | 'too-many-strokes'
  | 'too-many-points'

/** A rule outcome. Carries a code and where in the scene it happened, never submitted values. */
export interface CanvasIssue {
  code: CanvasIssueCode
  /** e.g. `elements[3]`; indexes only. */
  path?: string
}

export interface CanvasSceneCheck {
  scene: CanvasScene | null
  issues: CanvasIssue[]
}

export const emptyCanvasScene = (id: string, pageId: string): CanvasScene => ({
  format: CANVAS_FORMAT,
  version: CANVAS_VERSION,
  id,
  pageId,
  elements: [],
  edges: [],
  ink: []
})

const MAX_ISSUES = 100
const COLOR = /^#[0-9a-fA-F]{6}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(value, key))

/** Strictly validate an untrusted scene. On success `scene` is a canonical copy. */
export function checkCanvasScene(raw: unknown): CanvasSceneCheck {
  const issues: CanvasIssue[] = []
  const add = (code: CanvasIssueCode, path?: string): void => {
    if (issues.length < MAX_ISSUES) issues.push(path === undefined ? { code } : { code, path })
  }
  const fail = (): CanvasSceneCheck => ({ scene: null, issues })

  if (!isRecord(raw) || !hasOnlyKeys(raw, ['format', 'version', 'id', 'pageId', 'elements', 'edges', 'ink'])) {
    add('invalid-structure')
    return fail()
  }
  if (raw.format !== CANVAS_FORMAT) add('unsupported-format')
  if (raw.version !== CANVAS_VERSION) add('unsupported-version')
  if (!isNoteBlockId(raw.id)) add('invalid-id', 'id')
  if (!isNoteBlockId(raw.pageId)) add('invalid-id', 'pageId')
  const { elements: rawElements, edges: rawEdges, ink: rawInk } = raw
  if (!Array.isArray(rawElements) || !Array.isArray(rawEdges) || !Array.isArray(rawInk)) add('invalid-structure')
  if (issues.length > 0 || !Array.isArray(rawElements) || !Array.isArray(rawEdges) || !Array.isArray(rawInk)) return fail()
  if (rawElements.length > CANVAS_MAX_ELEMENTS) add('too-many-elements')
  if (rawEdges.length > CANVAS_MAX_EDGES) add('too-many-edges')
  if (rawInk.length > CANVAS_MAX_LAYERS) add('too-many-layers')
  if (issues.length > 0) return fail()

  const seen = new Set<string>()
  const claim = (id: unknown, path: string): id is string => {
    if (!isNoteBlockId(id)) {
      add('invalid-id', path)
      return false
    }
    if (seen.has(id)) add('duplicate-id', path)
    seen.add(id)
    return true
  }
  const num = (value: unknown, path: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      add('invalid-number', path)
      return 0
    }
    if (value < min || value > max) add('out-of-bounds', path)
    return value
  }
  const B = CANVAS_COORDINATE_LIMIT

  const elements: CanvasElementRef[] = []
  ;(rawElements as unknown[]).forEach((item, i) => {
    const path = `elements[${i}]`
    if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'blockId', 'x', 'y', 'width', 'height', 'z'])) return add('invalid-structure', path)
    claim(item.id, path)
    if (!isNoteBlockId(item.blockId)) add('invalid-id', `${path}.blockId`)
    elements.push({
      id: item.id as string,
      blockId: item.blockId as string,
      x: num(item.x, path, -B, B),
      y: num(item.y, path, -B, B),
      width: num(item.width, path, 1, CANVAS_SIZE_MAX),
      height: num(item.height, path, 1, CANVAS_SIZE_MAX),
      z: num(item.z, path, -B, B)
    })
  })

  const elementIds = new Set(elements.map((element) => element.id))
  const edges: CanvasEdge[] = []
  ;(rawEdges as unknown[]).forEach((item, i) => {
    const path = `edges[${i}]`
    if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'from', 'to'])) return add('invalid-structure', path)
    claim(item.id, path)
    if (typeof item.from !== 'string' || typeof item.to !== 'string' || !elementIds.has(item.from) || !elementIds.has(item.to) || item.from === item.to) {
      add('unknown-endpoint', path)
    }
    edges.push({ id: item.id as string, from: item.from as string, to: item.to as string })
  })

  const ink: InkLayer[] = []
  let strokeCount = 0
  let pointCount = 0
  ;(rawInk as unknown[]).forEach((layer, i) => {
    const path = `ink[${i}]`
    if (!isRecord(layer) || !hasOnlyKeys(layer, ['id', 'strokes']) || !Array.isArray(layer.strokes)) return add('invalid-structure', path)
    claim(layer.id, path)
    const strokes: InkStroke[] = []
    strokeCount += layer.strokes.length
    if (strokeCount > CANVAS_MAX_STROKES) {
      add('too-many-strokes', path)
      return
    }
    ;(layer.strokes as unknown[]).forEach((stroke, j) => {
      const spath = `${path}.strokes[${j}]`
      if (!isRecord(stroke) || !hasOnlyKeys(stroke, ['id', 'tool', 'color', 'width', 'points']) || !Array.isArray(stroke.points)) {
        return add('invalid-structure', spath)
      }
      claim(stroke.id, spath)
      if (stroke.tool !== 'pen' && stroke.tool !== 'highlighter') add('invalid-tool', spath)
      if (typeof stroke.color !== 'string' || !COLOR.test(stroke.color)) add('invalid-color', spath)
      const width = num(stroke.width, spath, 0.1, CANVAS_STROKE_WIDTH_MAX)
      pointCount += stroke.points.length
      if (stroke.points.length > CANVAS_MAX_POINTS_PER_STROKE || pointCount > CANVAS_MAX_POINTS) {
        add('too-many-points', spath)
        return
      }
      const points: [number, number, number][] = (stroke.points as unknown[]).map((p) => {
        if (!Array.isArray(p) || p.length !== 3) {
          add('invalid-structure', spath)
          return [0, 0, 0]
        }
        return [num(p[0], spath, -B, B), num(p[1], spath, -B, B), num(p[2], spath, 0, 1)]
      })
      strokes.push({
        id: stroke.id as string,
        tool: stroke.tool as InkStroke['tool'],
        color: typeof stroke.color === 'string' ? stroke.color.toLowerCase() : '',
        width,
        points
      })
    })
    ink.push({ id: layer.id as string, strokes })
  })

  if (issues.length > 0) return fail()
  return {
    issues,
    scene: { format: CANVAS_FORMAT, version: CANVAS_VERSION, id: raw.id as string, pageId: raw.pageId as string, elements, edges, ink }
  }
}

export type CanvasSceneErrorCode = 'unreadable' | 'too-new' | 'invalid'

/** Thrown for a stored scene that cannot be used. The message never contains the scene. */
export class CanvasSceneError extends Error {
  readonly code: CanvasSceneErrorCode
  constructor(code: CanvasSceneErrorCode) {
    super(
      code === 'too-new'
        ? 'Canvas was written by a newer version of the app.'
        : code === 'invalid'
          ? 'Canvas is not valid.'
          : 'Canvas could not be read.'
    )
    this.name = 'CanvasSceneError'
    this.code = code
  }
}

export type CanvasUpgraders = Record<number, (doc: unknown) => unknown>

/** Forward-only upgraders keyed by the version they upgrade FROM. Empty while v1 is the only version. */
const upgraders: CanvasUpgraders = {}

/** Stable JSON: canonical key order. */
export function serializeCanvasScene(scene: CanvasScene): string {
  return JSON.stringify({
    format: CANVAS_FORMAT,
    version: CANVAS_VERSION,
    id: scene.id,
    pageId: scene.pageId,
    elements: scene.elements.map((e) => ({ id: e.id, blockId: e.blockId, x: e.x, y: e.y, width: e.width, height: e.height, z: e.z })),
    edges: scene.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
    ink: scene.ink.map((layer) => ({
      id: layer.id,
      strokes: layer.strokes.map((s) => ({ id: s.id, tool: s.tool, color: s.color, width: s.width, points: s.points }))
    }))
  })
}

/** Read stored JSON, upgrade older versions, and validate. `table` is a test seam. */
export function parseStoredCanvasScene(json: string, table: CanvasUpgraders = upgraders): CanvasScene {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    throw new CanvasSceneError('unreadable')
  }
  const versionOf = (value: unknown): number => {
    const v = isRecord(value) ? value.version : undefined
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1
  }
  if (!isRecord(doc) || doc.format !== CANVAS_FORMAT) throw new CanvasSceneError('unreadable')
  let version = versionOf(doc)
  if (version < 0) throw new CanvasSceneError('unreadable')
  if (version > CANVAS_VERSION) throw new CanvasSceneError('too-new')
  while (version < CANVAS_VERSION) {
    const upgrade = Object.hasOwn(table, version) ? table[version] : undefined
    if (!upgrade) throw new CanvasSceneError('unreadable')
    doc = upgrade(doc)
    const next = versionOf(doc)
    if (next <= version) throw new CanvasSceneError('unreadable')
    version = next
  }
  const { scene } = checkCanvasScene(doc)
  if (!scene) throw new CanvasSceneError('invalid')
  return scene
}
