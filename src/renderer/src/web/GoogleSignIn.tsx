import { Alert } from '../clients/components'

// Placeholder sign-in page for the HTTPS Google mode (#180); #181 polishes it.
// A plain top-level form POST: no Google script, no client-side token handling.
// The host answers with a redirect to Google and, on return, sets the session.

const messages: Record<string, string> = {
  'not-approved': 'This Google account has not been approved yet. The owner has been notified and can approve it.',
  disabled: 'This account has been turned off. Ask the owner.',
  unavailable: 'Google sign-in is not available right now. Try again in a few minutes.',
  expired: 'That sign-in took too long or was not started here. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  busy: 'Too many sign-in attempts. Wait a minute, then try again.',
  failed: 'Sign-in did not work. Please try again.'
}

export function GoogleSignIn({ reason = null }: { reason?: string | null }) {
  const message = reason !== null && Object.hasOwn(messages, reason) ? messages[reason] : null
  return (
    <main>
      <h1>Tracing Guatemala</h1>
      <p>Sign in with the Google account the owner approved for you.</p>
      {message ? <Alert tone="error">{message}</Alert> : null}
      <form method="post" action="/api/v1/auth/google/start">
        <button type="submit">Sign in with Google</button>
      </form>
    </main>
  )
}
