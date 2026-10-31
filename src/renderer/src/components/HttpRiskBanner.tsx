import { isEncryptedTransport } from '../runtime/transport'

// Shown on every page of a paired home-network device (#137). Over plain HTTP
// anyone on that network can read the connection and pairing does not encrypt.
// Behind the opt-in HTTPS proxy (#167) the page scheme is https:, so the banner
// says so instead of claiming the connection is unencrypted.
export const HTTP_RISK_TEXT = 'Unencrypted HTTP — trusted home network only'
export const HTTPS_NOTE_TEXT = 'Encrypted (HTTPS) — home network only · fictional test data only'

export function HttpRiskBanner() {
  const text = isEncryptedTransport() ? HTTPS_NOTE_TEXT : HTTP_RISK_TEXT
  return (
    <div className="http-risk-banner" role="note" aria-label="Connection warning">
      <strong>{text}</strong>
    </div>
  )
}
