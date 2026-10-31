import { useState, type FormEvent } from 'react'
import { Alert } from '../clients/components'
import { enrollDevice, LiveApiError } from './liveApi'
import { isEncryptedTransport } from '../runtime/transport'

// Shown on a phone, tablet or computer that opens Live over the home network
// without a session (#136). The person types the pairing code that Settings
// shows on the researcher's computer. This does not encrypt anything: the notice
// says so plainly.

const messages: Record<string, string> = {
  'invalid-code': 'That code didn’t work. It may be wrong, expired or already used. Ask for a new one on the researcher’s computer.',
  'too-many-attempts': 'Too many tries. Wait a minute, then try again.',
  'too-many-devices': 'This home network already has the most devices paired. Remove one in Settings on the researcher’s computer first.',
  unreachable: 'Tracing Guatemala can’t be reached. Check that it is running on the researcher’s computer.',
  'invalid-request': 'That device name can’t be used. Use up to 40 letters or numbers.'
}

export const SESSION_ENDED_MESSAGE = 'Your session ended. Ask for a new pairing code on the researcher’s computer.'

export function EnrollDevice({
  enroll = enrollDevice,
  onDone = () => window.location.reload(),
  sessionEnded = false
}: {
  enroll?: (code: string, deviceName: string) => Promise<void>
  onDone?: () => void
  /** The session was revoked or expired while in use (#137). */
  sessionEnded?: boolean
}) {
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await enroll(code, deviceName)
      onDone()
    } catch (failure) {
      const key = failure instanceof LiveApiError ? failure.code : 'unreachable'
      setError(messages[key] ?? 'This device couldn’t be paired. Nothing was changed. Please try again.')
      setBusy(false)
    }
  }

  return (
    <main className="launch-required" aria-labelledby="enroll-heading">
      <section className="card">
        <h1 id="enroll-heading">Pair this device</h1>
        {sessionEnded && (
          <Alert tone="warning" title="Signed out">
            {SESSION_ENDED_MESSAGE}
          </Alert>
        )}
        <p>Enter the pairing code shown in Settings on the researcher’s computer.</p>
        {isEncryptedTransport() ? (
          <Alert tone="info" title="Encrypted connection">
            HTTPS — home network only. The pairing code and your session are encrypted in transit. This profile holds fictional test data only.
          </Alert>
        ) : (
          <Alert tone="warning" title="Unencrypted">
            Unencrypted HTTP — trusted home network only. The pairing code, your session and everything you open travel unencrypted.
          </Alert>
        )}
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="pairing-code">Pairing code</label>
            <input
              id="pairing-code"
              type="text"
              value={code}
              maxLength={20}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="device-name">Device name (optional)</label>
            <input
              id="device-name"
              type="text"
              value={deviceName}
              maxLength={40}
              autoComplete="off"
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </div>
          {error && (
            <Alert tone="error" title="Not paired">
              {error}
            </Alert>
          )}
          <div className="button-row">
            <button type="submit" className="button button-primary" disabled={busy || code.trim() === ''} aria-busy={busy}>
              {busy ? 'Pairing…' : 'Pair this device'}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
