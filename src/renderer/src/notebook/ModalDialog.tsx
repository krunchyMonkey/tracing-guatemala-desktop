import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

// A plain modal dialog for the notebook's own forms: labelled by its title, focus moves
// in and returns to the opener, Tab stays inside, Escape closes.

interface ModalDialogProps {
  title: string
  /** Wider body for lists and previews. */
  wide?: boolean
  onClose(): void
  children: ReactNode
  /** What to focus first; the first control otherwise. */
  initialFocus?: () => HTMLElement | null
  /** Where the focus goes when the dialog closes; the element that had it when opened otherwise. */
  returnFocus?: () => void
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]'

export function ModalDialog({ title, wide = false, onClose, children, initialFocus, returnFocus }: ModalDialogProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const focusFirst = useRef(initialFocus)
  const focusBack = useRef(returnFocus)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ;(focusFirst.current?.() ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus()
    return () => (focusBack.current ? focusBack.current() : opener?.focus())
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !ref.current) return
    const focusable = ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className="dialog-backdrop">
      <div ref={ref} className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}
