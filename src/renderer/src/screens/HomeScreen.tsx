import { Link } from 'react-router'
import { useAppRuntime } from '../runtime/AppRuntime'

export function HomeScreen() {
  if (useAppRuntime().mode === 'demo') {
    return (
      <section aria-labelledby="home-heading">
        <h1 id="home-heading">Welcome</h1>
        <p className="lead">A preview of the research workspace, filled with fictional clients.</p>
        <p className="placeholder-note">
          Try the <Link to="/clients">Clients</Link> screen: search and filter, add or edit a client, write notes and
          contact entries, and archive or restore a client. Nothing is saved; refreshing the page resets the demo.
        </p>
      </section>
    )
  }
  return (
    <section aria-labelledby="home-heading">
      <h1 id="home-heading">Welcome</h1>
      <p className="lead">Your research workspace. Everything you add stays on this computer.</p>
      <p className="placeholder-note">This is an early preview. Client management is being built next.</p>
    </section>
  )
}
