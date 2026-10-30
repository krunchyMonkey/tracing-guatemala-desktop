import type { CanvasScene } from '../../../src/shared/notebook-canvas'
import type { CanvasSurfaceAdapter, CanvasSurfaceOptions, CanvasSurfaceSession } from '../../../src/renderer/src/notebook/ports'

// An in-memory canvas double: stores the scene, simulates user edits with draw().

export interface FakeCanvasSession extends CanvasSurfaceSession {
  readonly options: CanvasSurfaceOptions
  readonly isEditable: () => boolean
  readonly isDestroyed: () => boolean
  /** Simulates the user changing the scene. */
  draw(scene: CanvasScene): void
}

export interface FakeCanvasAdapter extends CanvasSurfaceAdapter {
  readonly sessions: FakeCanvasSession[]
}

export function createFakeCanvasAdapter(): FakeCanvasAdapter {
  const sessions: FakeCanvasSession[] = []
  return {
    id: 'fake-canvas',
    displayName: 'Fake canvas',
    sessions,
    create(options) {
      let scene = structuredClone(options.scene)
      let editable = options.editable
      let destroyed = false
      const session: FakeCanvasSession = {
        options,
        isEditable: () => editable,
        isDestroyed: () => destroyed,
        getScene: () => structuredClone(scene),
        setScene(next) {
          scene = structuredClone(next)
        },
        setEditable(next) {
          editable = next
        },
        draw(next) {
          if (destroyed || !editable) return
          scene = structuredClone(next)
          options.onChange(structuredClone(scene))
        },
        destroy() {
          destroyed = true
          options.element.replaceChildren()
        }
      }
      sessions.push(session)
      return session
    }
  }
}
