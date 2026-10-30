import { NavLink, Outlet } from 'react-router'
import { useAppRuntime } from '../runtime/AppRuntime'
import { DemoBanner } from './DemoBanner'

const navItems = [
  { to: '/', label: 'Home', end: true },
  { to: '/clients', label: 'Clients', end: false },
  { to: '/settings', label: 'Settings & Backup', end: false }
]

const casesItem = { to: '/cases', label: 'Cases', end: false }

export function AppLayout() {
  const runtime = useAppRuntime()
  const demo = runtime.mode === 'demo'
  // Research cases exist only where the runtime provides them (not in the desktop app).
  const items = runtime.cases ? [...navItems.slice(0, 2), casesItem, ...navItems.slice(2)] : navItems
  return (
    <div className={demo ? 'app-shell has-demo-banner' : 'app-shell'}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {demo && <DemoBanner />}
      <aside className="sidebar">
        <p className="brand">
          Tracing Guatemala
          <span className="brand-tagline">Research workspace</span>
        </p>
        <nav aria-label="Main">
          <ul>
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {runtime.mode === 'live' && <p className="live-status">Live · saved on this computer</p>}
      </aside>
      <main id="main-content" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
