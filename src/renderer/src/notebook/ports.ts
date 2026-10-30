// Vendor-neutral notebook ports (#146). Screens know only these types and the app's
// own shared/ types. Editor and canvas libraries live behind them under adapters/<provider>/,
// the only place their packages may be imported (see eslint.config.mjs). No port type
// mentions a vendor document, node or instance.

import type { CanvasScene } from '../../../shared/notebook-canvas'
import type { InlineMark, NoteBlock, NoteContent, RecordRef } from '../../../shared/note-content'

export type BlockKind = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'numbered' | 'check'

export type EditorCommand =
  | { type: 'toggleMark'; mark: InlineMark }
  | { type: 'setBlock'; block: BlockKind }
  | { type: 'indent' }
  | { type: 'outdent' }
  | { type: 'setLink'; href: string | null }
  | { type: 'insertDivider' }
  | { type: 'insertReference'; target: RecordRef }
  | { type: 'undo' }
  | { type: 'redo' }

export interface EditorState {
  canUndo: boolean
  canRedo: boolean
  activeMarks: InlineMark[]
  /** The kind of the block holding the caret; null when there is none or it is not a text block. */
  activeBlock: BlockKind | null
  selectedText: string
  focused: boolean
}

export interface RichTextEditorOptions {
  element: HTMLElement
  content: NoteContent
  editable: boolean
  /** Accessible name of the editing surface. */
  label: string
  placeholder?: string
  /** Makes block ids for new blocks. */
  newId: () => string
  /** Called for every user edit; the app debounces. Not called by `setContent`. */
  onChange: (content: NoteContent) => void
  onStateChange?: (state: EditorState) => void
  /** Display label for a reference block. Adapters render it as text, never HTML. */
  describeReference?: (ref: RecordRef) => string
}

export interface RichTextEditorSession {
  /** Always normalized, valid NoteContent. */
  getContent(): NoteContent
  /** Replaces the content and clears undo history. Does not call onChange. */
  setContent(content: NoteContent): void
  setEditable(editable: boolean): void
  focus(): void
  /** True when the command was honored; false when the adapter cannot, or the editor is read-only. */
  run(command: EditorCommand): boolean
  getState(): EditorState
  destroy(): void
}

export interface RichTextEditorAdapter {
  readonly id: string
  readonly displayName: string
  create(options: RichTextEditorOptions): RichTextEditorSession
}

export interface CanvasSurfaceOptions {
  element: HTMLElement
  scene: CanvasScene
  editable: boolean
  /** Looks up the canonical block an element points at; null when it no longer exists. */
  resolveBlock: (blockId: string) => NoteBlock | null
  onChange: (scene: CanvasScene) => void
}

export interface CanvasSurfaceSession {
  getScene(): CanvasScene
  /** Replaces the scene. Does not call onChange. */
  setScene(scene: CanvasScene): void
  setEditable(editable: boolean): void
  destroy(): void
}

export interface CanvasSurfaceAdapter {
  readonly id: string
  readonly displayName: string
  create(options: CanvasSurfaceOptions): CanvasSurfaceSession
}
