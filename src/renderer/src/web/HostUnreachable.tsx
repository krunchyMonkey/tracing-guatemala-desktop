import { HttpRiskBanner } from '../components/HttpRiskBanner'

// A paired home-network device that can't reach the researcher's computer (#137):
// it may be asleep, stopped, or this device may be on a different network. Never
// mentions the private link, which belongs to the host's own computer.
export function HostUnreachable({ onRetry = () => window.location.reload() }: { onRetry?: () => void }) {
  return (
    <>
      <HttpRiskBanner />
      <main className="launch-required" aria-labelledby="unreachable-heading">
        <section className="card">
          <h1 id="unreachable-heading">Can’t reach the researcher’s computer</h1>
          <p>Can’t reach the researcher’s computer. It may be asleep, stopped, or on a different network. Nothing you saved is lost.</p>
          <div className="button-row">
            <button type="button" className="button button-primary" onClick={onRetry}>
              Retry
            </button>
          </div>
        </section>
      </main>
    </>
  )
}
