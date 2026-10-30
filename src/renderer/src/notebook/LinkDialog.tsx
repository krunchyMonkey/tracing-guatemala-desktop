import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { isSafeHref } from '../../../shared/note-content'

// Asks for a link address. Only http, https and mailto addresses are accepted (the
// same rule the saved page content follows); anything else is explained, not stored.

interface LinkDialogProps {
  selectedText: string
  onApply(href: string): boolean
  onRemove(): void
  onCancel(): void
}

export function LinkDialog({ selectedText, onApply, onRemove, onCancel }: LinkDialogProps) {
  const titleId = useId()
  const inputId = useId()
  const errorId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => opener?.focus()
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const href = address.trim()
    if (!isSafeHref(href)) {
      setError('Enter an address that starts with https://, http:// or mailto:')
      inputRef.current?.focus()
      return
    }
    if (!onApply(href)) {
      setError('Select the words to link first, then try again.')
      return
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input')
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
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 id={titleId}>Link</h2>
        <form onSubmit={submit} noValidate>
          {selectedText !== '' && <p className="muted note-link-selection">Linking “{selectedText.length > 60 ? `${selectedText.slice(0, 60)}…` : selectedText}”</p>}
          <div className={`field${error ? ' field-invalid' : ''}`}>
            <label htmlFor={inputId}>Web address</label>
            <input
              id={inputId}
              ref={inputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.org"
              value={address}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setAddress(event.target.value)
                setError(null)
              }}
            />
            {error && (
              <p id={errorId} className="issue-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-actions">
            <button type="button" className="button button-ghost" onClick={onRemove}>
              Remove link
            </button>
            <button type="button" className="button button-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="button button-primary">
              Apply link
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
