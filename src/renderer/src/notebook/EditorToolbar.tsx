import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { InlineMark } from '../../../shared/note-content'
import type { BlockKind, EditorCommand, EditorState } from './ports'

// The formatting toolbar. It only knows the editor port: it reports EditorCommands and
// reads EditorState, so it works with any adapter. One tab stop for the whole bar,
// arrow keys move between the controls (roving tabindex); buttons never take the focus
// from the text on mouse down, so the selection they act on stays.

const BLOCK_OPTIONS: { value: BlockKind; label: string }[] = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'heading1', label: 'Heading 1' },
  { value: 'heading2', label: 'Heading 2' },
  { value: 'heading3', label: 'Heading 3' }
]

const MARK_BUTTONS: { mark: InlineMark; label: string; glyph: ReactNode }[] = [
  { mark: 'bold', label: 'Bold', glyph: <strong>B</strong> },
  { mark: 'italic', label: 'Italic', glyph: <em>I</em> },
  { mark: 'underline', label: 'Underline', glyph: <span className="tool-underline">U</span> },
  { mark: 'strike', label: 'Strikethrough', glyph: <s>S</s> },
  { mark: 'code', label: 'Code', glyph: <code>{'</>'}</code> }
]

const LIST_BUTTONS: { block: BlockKind; label: string; glyph: string }[] = [
  { block: 'bullet', label: 'Bulleted list', glyph: '• List' },
  { block: 'numbered', label: 'Numbered list', glyph: '1. List' },
  { block: 'check', label: 'Checklist', glyph: '☐ Tasks' }
]

interface EditorToolbarProps {
  state: EditorState
  disabled: boolean
  onCommand(command: EditorCommand): void
  onLink(): void
  /** The workflow bridge (#149); left out where the case can't be changed. */
  bridge?: { onLinkRecord(): void; onCreateTask(): void; onCreateJournal(): void }
}

export function EditorToolbar({ state, disabled, onCommand, onLink, bridge }: EditorToolbarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const blockLabelId = useId()

  const items = (): HTMLElement[] => [...(barRef.current?.querySelectorAll<HTMLElement>('[data-tool]') ?? [])].filter((el) => !el.hasAttribute('disabled'))

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const all = items()
    const index = all.indexOf(event.target as HTMLElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length
    const target = all[next]!
    setActive(Number(target.dataset['tool']))
    target.focus()
  }

  let counter = 0
  /** Shared props for every control: roving tab stop, no focus stealing, group order. */
  const tool = () => {
    const position = counter
    counter += 1
    return {
      'data-tool': position,
      tabIndex: position === active ? 0 : -1,
      onFocus: () => setActive(position)
    }
  }
  const press = (command: EditorCommand) => () => onCommand(command)
  const keepSelection = { onMouseDown: (event: { preventDefault(): void }) => event.preventDefault() }

  const blockValue = BLOCK_OPTIONS.some((o) => o.value === state.activeBlock) ? state.activeBlock! : 'list'

  return (
    <div ref={barRef} className="note-toolbar" role="toolbar" aria-label="Formatting" aria-orientation="horizontal" onKeyDown={onKeyDown}>
      <div className="note-tool-group" role="group" aria-label="History">
        <button type="button" className="note-tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={disabled} aria-disabled={!state.canUndo} onClick={state.canUndo ? press({ type: 'undo' }) : undefined} {...keepSelection} {...tool()}>
          <span aria-hidden="true">↶</span>
        </button>
        <button type="button" className="note-tool" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={disabled} aria-disabled={!state.canRedo} onClick={state.canRedo ? press({ type: 'redo' }) : undefined} {...keepSelection} {...tool()}>
          <span aria-hidden="true">↷</span>
        </button>
      </div>

      <div className="note-tool-group" role="group" aria-label="Block type">
        <label id={blockLabelId} className="visually-hidden" htmlFor={`${blockLabelId}-select`}>
          Block type
        </label>
        <select
          id={`${blockLabelId}-select`}
          className="note-tool-select"
          value={blockValue}
          disabled={disabled}
          onChange={(event) => onCommand({ type: 'setBlock', block: event.target.value as BlockKind })}
          {...tool()}
        >
          {blockValue === 'list' && (
            <option value="list" disabled>
              List item
            </option>
          )}
          {BLOCK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="note-tool-group" role="group" aria-label="Text style">
        {MARK_BUTTONS.map(({ mark, label, glyph }) => (
          <button
            key={mark}
            type="button"
            className="note-tool"
            aria-label={label}
            aria-pressed={state.activeMarks.includes(mark)}
            title={label}
            disabled={disabled}
            onClick={press({ type: 'toggleMark', mark })}
            {...keepSelection}
            {...tool()}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        ))}
        <button type="button" className="note-tool" aria-label="Link" title="Add or change a link" disabled={disabled} onClick={onLink} {...keepSelection} {...tool()}>
          <span aria-hidden="true">Link</span>
        </button>
      </div>

      <div className="note-tool-group" role="group" aria-label="Lists and structure">
        {LIST_BUTTONS.map(({ block, label, glyph }) => {
          const pressed = state.activeBlock === block
          return (
            <button
              key={block}
              type="button"
              className="note-tool note-tool-wide"
              aria-label={label}
              aria-pressed={pressed}
              title={label}
              disabled={disabled}
              onClick={press({ type: 'setBlock', block: pressed ? 'paragraph' : block })}
              {...keepSelection}
              {...tool()}
            >
              <span aria-hidden="true">{glyph}</span>
            </button>
          )
        })}
        <button type="button" className="note-tool" aria-label="Indent" title="Indent (Tab in a list)" disabled={disabled} onClick={press({ type: 'indent' })} {...keepSelection} {...tool()}>
          <span aria-hidden="true">→|</span>
        </button>
        <button type="button" className="note-tool" aria-label="Outdent" title="Outdent (Shift+Tab in a list)" disabled={disabled} onClick={press({ type: 'outdent' })} {...keepSelection} {...tool()}>
          <span aria-hidden="true">|←</span>
        </button>
        <button type="button" className="note-tool" aria-label="Divider" title="Insert a divider" disabled={disabled} onClick={press({ type: 'insertDivider' })} {...keepSelection} {...tool()}>
          <span aria-hidden="true">―</span>
        </button>
      </div>

      {bridge && (
        <div className="note-tool-group" role="group" aria-label="Case records">
          <button type="button" className="note-tool note-tool-wide" aria-label="Link record" title="Link a journal entry, task or hours entry of this case" disabled={disabled} onClick={bridge.onLinkRecord} {...keepSelection} {...tool()}>
            <span aria-hidden="true">Link record</span>
          </button>
          <button type="button" className="note-tool note-tool-wide" aria-label="Create task from selection" title="Create a task from the selected text (you confirm first)" disabled={disabled} onClick={bridge.onCreateTask} {...keepSelection} {...tool()}>
            <span aria-hidden="true">+ Task</span>
          </button>
          <button type="button" className="note-tool note-tool-wide" aria-label="Add to journal from selection" title="Add the selected text to the research journal (you confirm first)" disabled={disabled} onClick={bridge.onCreateJournal} {...keepSelection} {...tool()}>
            <span aria-hidden="true">+ Journal</span>
          </button>
        </div>
      )}
    </div>
  )
}
