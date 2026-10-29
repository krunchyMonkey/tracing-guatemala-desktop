import { NavLink, Outlet } from 'react-router'

const navItems = [
  { to: '/', label: 'Home', end: true },
  { to: '/clients', label: 'Clients', end: false },
  { to: '/settings', label: 'Settings & Backup', end: false }
]

export function AppLayout() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <p className="brand">Tracing Guatemala</p>
        <nav aria-label="Main">
          <ul>
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main id="main-content" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
