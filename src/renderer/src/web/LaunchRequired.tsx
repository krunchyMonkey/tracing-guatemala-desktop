// Shown instead of the app when the Live web host (#110) doesn't know this
// browser: it wasn't opened through the launch link, the host was restarted,
// or the host isn't running.

export function LaunchRequired({
  reason,
  demoHref = null
}: {
  reason: 'signed-out' | 'session-ended' | 'unreachable'
  /** A checked address of the fictional demo (#114); never offered when the host is unreachable. */
  demoHref?: string | null
}) {
  const heading = reason === 'unreachable' ? 'Tracing Guatemala isn’t running' : 'Open Tracing Guatemala from its link'
  return (
    <main className="launch-required" aria-labelledby="launch-heading">
      <section className="card">
        <h1 id="launch-heading">{heading}</h1>
        {reason === 'session-ended' && <p>Tracing Guatemala was restarted, so this window was signed out. Nothing was lost.</p>}
        {reason === 'unreachable' ? (
          <p>Start it again on this computer, then open the private link it shows.</p>
        ) : (
          <p>
            For your privacy, this page only opens through the private link shown in the Tracing Guatemala window when it
            starts. Open that link on this computer.
          </p>
        )}
        {demoHref && reason !== 'unreachable' && (
          <p>
            <a href={demoHref} rel="noreferrer">
              Open the fictional demo instead
            </a>{' '}
            (made-up data, nothing is saved).
          </p>
        )}
      </section>
    </main>
  )
}
