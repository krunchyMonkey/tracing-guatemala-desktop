import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Outlet } from 'react-router'
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
  confirmDisabled?: boolean
  onConfirm(): void
  onCancel(): void
}

/** Modal confirmation. Focus starts on the safe choice (Cancel); Escape cancels. */
export function ConfirmDialog({ title, children, confirmLabel, tone = 'default', confirmDisabled = false, onConfirm, onCancel }: ConfirmDialogProps) {
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
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Renders the client screens once the saved clients have loaded, with loading and retry states. */
export function ClientsLoaded() {
  const { loadState, reload } = useClientStore()
  if (loadState === 'loading') {
    return (
      <p role="status" className="muted">
        Loading clients…
      </p>
    )
  }
  if (loadState === 'error') {
    return (
      <section aria-labelledby="load-error-heading">
        <h1 id="load-error-heading">Clients</h1>
        <Alert tone="error" title="Your clients couldn’t be loaded">
          <p>Nothing was changed or lost. Try again, or restart the app if this keeps happening.</p>
          <button type="button" className="button button-secondary" onClick={reload}>
            Try again
          </button>
        </Alert>
      </section>
    )
  }
  return <Outlet />
}
