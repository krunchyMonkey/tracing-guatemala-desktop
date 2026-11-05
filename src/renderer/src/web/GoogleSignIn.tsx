import { useEffect, useState } from 'react'
import { Alert } from '../clients/components'

// Sign-in page of the HTTPS Google mode (#180, #181). A plain top-level form
// POST: no Google script, no client-side token handling. The host answers with a
// redirect to Google and, on return, sets the session cookie. The copy says
// nothing about who has an account here: every "no" sounds the same to a stranger.

const messages: Record<string, { title: string; text: string }> = {
  'not-approved': {
    title: 'Not approved yet',
    text: 'This Google account isn’t approved for Tracing Guatemala yet. The owner can approve it from Users.'
  },
  disabled: { title: 'Account turned off', text: 'This account has been turned off. Ask the owner to turn it back on from Users.' },
  unavailable: { title: 'Google is unavailable', text: 'Google sign-in isn’t available right now. Try again in a few minutes.' },
  expired: { title: 'Sign-in timed out', text: 'That sign-in took too long or was not started here. Please try again.' },
  cancelled: { title: 'Sign-in cancelled', text: 'Sign-in was cancelled. Nothing was changed. You can try again.' },
  busy: { title: 'Too many attempts', text: 'Too many sign-in attempts. Wait a minute, then try again.' },
  failed: { title: 'Sign-in didn’t work', text: 'Sign-in did not work. Please try again.' }
}

export const SIGN_IN_SESSION_ENDED_MESSAGE = 'Your session ended. Sign in again.'

/**
 * Reads the `?signin=<reason>` the host redirected with and removes it from the
 * address bar, so a reload or a shared link doesn't repeat the message.
 */
export function takeSignInReason(win: Pick<Window, 'location' | 'history'> = window): string | null {
  const params = new URLSearchParams(win.location.search)
  if (!params.has('signin')) return null
  const reason = params.get('signin')
  params.delete('signin')
  const query = params.toString()
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${query ? `?${query}` : ''}${win.location.hash}`)
  return reason
}

function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export function GoogleSignIn({ reason = null, sessionEnded = false }: { reason?: string | null; sessionEnded?: boolean }) {
  const online = useOnline()
  const message = reason !== null && Object.hasOwn(messages, reason) ? messages[reason] : null
  return (
    <main className="launch-required" aria-labelledby="signin-heading">
      <section className="card sign-in-card">
        <h1 id="signin-heading">Tracing Guatemala</h1>
        <p>Sign in with the Google account the owner approved for you.</p>
        {!online && (
          <Alert tone="warning" title="No network connection">
            Check your internet connection. You can sign in again when it is back.
          </Alert>
        )}
        {sessionEnded && (
          <Alert tone="warning" title="Signed out">
            {SIGN_IN_SESSION_ENDED_MESSAGE}
          </Alert>
        )}
        {message && (
          <Alert tone="error" title={message.title}>
            {message.text}
          </Alert>
        )}
        {/* A same-origin link, not a form: the page CSP keeps form-action 'none' (#181). */}
        {online ? (
          <a className="google-signin-button" href="/api/v1/auth/google/start">
            <GoogleMark />
            <span>Sign in with Google</span>
          </a>
        ) : (
          <button type="button" className="google-signin-button" disabled>
            <GoogleMark />
            <span>Sign in with Google</span>
          </button>
        )}
        <p className="muted">Your Google password is never shared with Tracing Guatemala. Only your name and email address are used.</p>
      </section>
    </main>
  )
}
