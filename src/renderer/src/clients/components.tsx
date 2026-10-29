import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useClientStore } from './ClientStore'
import { sourceLabels, type ClientSource, type ClientStatus } from './model'

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso))
}

export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso))
}

export function StatusBadge({ status }: { status: ClientStatus }) {
  return <span className={`badge badge-${status}`}>{status === 'active' ? 'Active' : 'Archived'}</span>
}

export function SourceTag({ source }: { source: ClientSource }) {
  return <span className={`source-tag source-${source}`}>{sourceLabels[source]}</span>
}

export function Alert({ tone, title, children }: { tone: 'error' | 'warning' | 'info'; title?: string; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <p className="alert-title">{title}</p>}
      <div>{children}</div>
    </div>
  )
}

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  tone?: 'default' | 'caution'
  onConfirm(): void
  onCancel(): void
}

/** Modal confirmation. Focus starts on the safe choice (Cancel); Escape cancels. */
export function ConfirmDialog({ title, children, confirmLabel, tone = 'default', onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId()
  const bodyId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => opener?.focus()
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button')
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
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId}>{children}</div>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${tone === 'caution' ? 'button-caution' : 'button-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Review-only controls so the researcher can see empty and error states. Not part of the proposed product. */
export function PrototypeBanner() {
  const { clients, loadSample, clearAll, simulateFailures, setSimulateFailures } = useClientStore()
  return (
    <aside className="prototype-banner" aria-label="Prototype controls">
      <p>
        <strong>Prototype for review.</strong> Sample clients are fictional, and nothing is saved when you close the
        app.
      </p>
      <div className="prototype-controls">
        {clients.length > 0 ? (
          <button type="button" className="button button-small button-ghost" onClick={clearAll}>
            Show empty directory
          </button>
        ) : (
          <button type="button" className="button button-small button-ghost" onClick={loadSample}>
            Load sample clients
          </button>
        )}
        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={simulateFailures}
            onChange={(event) => setSimulateFailures(event.target.checked)}
          />
          Simulate save errors
        </label>
      </div>
    </aside>
  )
}
