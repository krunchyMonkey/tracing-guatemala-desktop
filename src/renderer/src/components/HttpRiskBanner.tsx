// Shown on every page of a paired home-network device (#137): the connection is
// plain HTTP, so anyone on that network can read it. Pairing does not encrypt.
export const HTTP_RISK_TEXT = 'Unencrypted HTTP — trusted home network only'

export function HttpRiskBanner() {
  return (
    <div className="http-risk-banner" role="note" aria-label="Connection warning">
      <strong>{HTTP_RISK_TEXT}</strong>
    </div>
  )
}
