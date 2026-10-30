import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  buildFeedbackPayload,
  categoryLabels,
  feedbackAsText,
  feedbackCategories,
  feedbackLimits,
  newIdempotencyKey,
  type FeedbackCategory,
  type ScreenLabel
} from './feedback/payload'

// "Send feedback" form of the browser demo (#102). The demo's page policy forbids
// network requests, so by default it only offers Copy feedback. Only when the host
// was started with `npm run demo:lan:feedback` does it serve a marker in the page
// and /__feedback/status; then (and only then) the page may ask that same-origin
// route and offer Submit. The access code is typed by the researcher and kept in
// this component's memory only.

export const PRIVACY_TEXT =
  'Feedback goes to a private Tracing Guatemala project. Please don’t include real client names or genealogy records. This demo uses plain HTTP on your home network.'

type Availability = 'checking' | 'send' | 'copy'
type Outcome = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; itemUrl?: string } | { kind: 'error'; message: string }

function hostOffersFeedback(): boolean {
  return document.querySelector('meta[name="tg-feedback"]')?.getAttribute('content') === 'available'
}

async function readStatus(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch('/__feedback/status', { signal, cache: 'no-store', credentials: 'omit' })
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return false
    const body = (await response.json()) as { enabled?: unknown }
    return body.enabled === true
  } catch {
    return false
  }
}

const GENERIC_FAILURE = 'Feedback could not be sent. Your text is kept; you can try again or copy it.'

const failureText: Record<number, string> = {
  401: 'That access code was not accepted. Ask the person running the demo for it.',
  403: 'The demo host refused this request.',
  413: 'That feedback is too long to send.',
  400: 'That feedback could not be sent. Check the lengths and try again.',
  429: 'Too many attempts. Wait a minute and try again.',
  503: 'Sending is not available right now.'
}

interface Props {
  screen: ScreenLabel
  guideStep: string | null
  appVersion: string
  onClose(): void
}

export function FeedbackDialog({ screen, guideStep, appVersion, onClose }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstField = useRef<HTMLSelectElement>(null)
  const copyBox = useRef<HTMLTextAreaElement>(null)
  const [availability, setAvailability] = useState<Availability>(hostOffersFeedback() ? 'checking' : 'copy')
  const [category, setCategory] = useState<FeedbackCategory>('confusing')
  const [title, setTitle] = useState('')
  const [comments, setComments] = useState('')
  const [steps, setSteps] = useState('')
  const [code, setCode] = useState('')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const [copied, setCopied] = useState<'no' | 'yes' | 'manual'>('no')
  // One key per open form, so a double click or a retry never makes two items.
  const [key] = useState(() => newIdempotencyKey())

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    firstField.current?.focus()
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    if (availability !== 'checking') return
    const controller = new AbortController()
    void readStatus(controller.signal).then((enabled) => {
      if (!controller.signal.aborted) setAvailability(enabled ? 'send' : 'copy')
    })
    return () => controller.abort()
  }, [availability])

  const payload = buildFeedbackPayload({ category, title, comments, steps, screen, guideStep, appVersion, idempotencyKey: key })
  const ready = payload.title.length > 0 && payload.comments.length > 0

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea:not([hidden]), a[href]')
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

  async function copy() {
    const box = copyBox.current
    if (!box) return
    box.value = feedbackAsText(payload)
    box.hidden = false
    box.select()
    try {
      // navigator.clipboard needs a secure context, which plain-HTTP LAN origins aren't.
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(box.value)
      else if (!document.execCommand('copy')) throw new Error('copy failed')
      setCopied('yes')
    } catch {
      setCopied('manual')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || outcome.kind === 'sending' || !code.trim()) return
    setOutcome({ kind: 'sending' })
    try {
      const response = await fetch('/__feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Feedback-Code': code.trim() },
        body: JSON.stringify(payload),
        credentials: 'omit',
        cache: 'no-store'
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: unknown; itemUrl?: unknown }
      if (response.ok && body.ok === true) {
        setOutcome({ kind: 'sent', itemUrl: typeof body.itemUrl === 'string' ? body.itemUrl : undefined })
        return
      }
      setOutcome({ kind: 'error', message: failureText[response.status] ?? GENERIC_FAILURE })
    } catch {
      setOutcome({ kind: 'error', message: GENERIC_FAILURE })
    }
  }

  const sending = outcome.kind === 'sending'

  return (
    <div className="dialog-backdrop">
      <div ref={dialogRef} className="dialog feedback-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 id={titleId}>Send feedback</h2>
        <p className="feedback-privacy">{PRIVACY_TEXT}</p>

        {outcome.kind === 'sent' ? (
          <div role="status" className="feedback-sent">
            <p>
              <strong>Feedback added to private project.</strong> Thank you!
            </p>
            {outcome.itemUrl && (
              <p>
                <a href={outcome.itemUrl} target="_blank" rel="noreferrer noopener">
                  Open the private project
                </a>{' '}
                <span className="muted">(only people with project access can see it)</span>
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="button button-primary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="feedback-form">
            <div className="field">
              <label htmlFor="feedback-category">What kind of feedback?</label>
              <select ref={firstField} id="feedback-category" value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategory)}>
                {feedbackCategories.map((value) => (
                  <option key={value} value={value}>
                    {categoryLabels[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="feedback-title">Short title</label>
              <input id="feedback-title" value={title} maxLength={feedbackLimits.title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="feedback-comments">Comments</label>
              <textarea id="feedback-comments" rows={4} value={comments} maxLength={feedbackLimits.comments} onChange={(e) => setComments(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="feedback-steps">Steps to reproduce (optional)</label>
              <textarea id="feedback-steps" rows={2} value={steps} maxLength={feedbackLimits.steps} onChange={(e) => setSteps(e.target.value)} />
            </div>
            <p className="muted feedback-context">
              Sent with it: the screen name ({screen}){guideStep ? `, tour step ${guideStep}` : ''} and the app version. Nothing else from this page.
            </p>

            {availability === 'send' && (
              <div className="field">
                <label htmlFor="feedback-code">Access code</label>
                <input id="feedback-code" value={code} autoComplete="off" spellCheck={false} maxLength={12} onChange={(e) => setCode(e.target.value)} />
                <p className="muted">Ask the person running the demo for the code shown on their computer.</p>
              </div>
            )}
            {availability === 'copy' && (
              <p className="feedback-copy-note">
                Sending isn’t turned on for this demo, so nothing leaves this page. Use <strong>Copy feedback</strong> and paste it into a message instead.
              </p>
            )}

            {outcome.kind === 'error' && (
              <p role="alert" className="feedback-error">
                {outcome.message}
              </p>
            )}
            <textarea ref={copyBox} hidden readOnly rows={6} aria-label="Feedback to copy" className="feedback-copy-box" />
            {copied !== 'no' && (
              <p role="status" className="muted">
                {copied === 'yes' ? 'Copied. Paste it into a message.' : 'Select the text above and copy it.'}
              </p>
            )}

            <div className="dialog-actions">
              <button type="button" className="button button-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="button button-secondary" disabled={!ready} onClick={() => void copy()}>
                Copy feedback
              </button>
              {availability === 'send' && (
                <button type="submit" className="button button-primary" disabled={!ready || sending || !code.trim()}>
                  {sending ? 'Sending…' : 'Submit feedback'}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
