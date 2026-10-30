import { NavLink, Outlet } from 'react-router'
import { useAppRuntime } from '../runtime/AppRuntime'
import { TimerProvider } from '../cases/TimerContext'
import { DemoBanner } from './DemoBanner'
import { HttpRiskBanner } from './HttpRiskBanner'
import { ModeSwitcher } from './ModeSwitcher'
import { TimerPill } from './TimerPill'

const navItems = [
  { to: '/', label: 'Home', end: true },
  { to: '/clients', label: 'Clients', end: false },
  { to: '/settings', label: 'Settings & Backup', end: false }
]

const casesItem = { to: '/cases', label: 'Cases', end: false }

// A product-roadmap preview, not functioning navigation. Individual phases own
// their routes and remove these placeholders only when the features ship.
const upcomingItems = [
  { label: 'Evidence Library', phase: 3 },
  { label: 'Document AI', phase: 4 },
  { label: 'Client Reports', phase: 5 },
  { label: 'Family Trees', phase: 6 },
  { label: 'Research Copilot', phase: 7 },
  { label: 'Integrations', phase: 8 },
  { label: 'Business Tools', phase: 9 }
] as const

export function AppLayout() {
  const runtime = useAppRuntime()
  const demo = runtime.mode === 'demo'
  // A paired home-network device always sees the HTTP warning (#137).
  const remote = runtime.mode === 'live' && runtime.remote === true
  // Research cases exist only where the runtime provides them (not in the desktop app).
  const items = runtime.cases ? [...navItems.slice(0, 2), casesItem, ...navItems.slice(2)] : navItems
  return (
    <TimerProvider>
    <div className={demo || remote ? 'app-shell has-demo-banner' : 'app-shell'}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {demo && <DemoBanner />}
      {remote && <HttpRiskBanner />}
      <aside className="sidebar">
        <p className="brand">
          Tracing Guatemala
          <span className="brand-tagline">Research workspace</span>
        </p>
        <ModeSwitcher />
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
          <section className="upcoming-nav" aria-labelledby="upcoming-nav-heading">
            <h2 className="upcoming-nav-heading" id="upcoming-nav-heading">
              Coming soon <span aria-hidden="true">✦</span>
            </h2>
            <ul className="upcoming-nav-list">
              {upcomingItems.map((item) => (
                <li key={item.phase}>
                  <button
                    className="upcoming-nav-item"
                    type="button"
                    disabled
                    title={`${item.label} — planned for Phase ${item.phase}`}
                    aria-label={`${item.label}, coming soon in Phase ${item.phase}`}
                  >
                    <svg
                      className="upcoming-nav-lock"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <rect x="5" y="10" width="14" height="11" rx="2" />
                      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                    </svg>
                    <span className="upcoming-nav-name">{item.label}</span>
                    <span className="upcoming-nav-phase" aria-hidden="true">P{item.phase}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </nav>
        <TimerPill />
      </aside>
      <main id="main-content" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
    </TimerProvider>
  )
}
