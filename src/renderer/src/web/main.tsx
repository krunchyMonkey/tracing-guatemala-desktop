import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import { isUserRole } from '../../../shared/users'
import type { AppRuntime, SignedInPerson } from '../runtime/AppRuntime'
import '../styles.css'
import { liveModeSwitch, validDemoHref } from './demoLink'
import { EnrollDevice } from './EnrollDevice'
import { HostUnreachable } from './HostUnreachable'
import { LaunchRequired } from './LaunchRequired'
import { GoogleSignIn, takeSignInReason } from './GoogleSignIn'
import { createLiveApi, fetchSession } from './liveApi'

// Entry point of the Live web app (#110, vite.web.config.ts): the shared UI
// over the loopback local web host. Without a session (the browser didn't come
// through the launch link, or the host restarted) it only explains what to do.
// Over the home network (#136) a signed-out browser enrolls with a pairing code
// instead, and a paired device gets the same app without backups.
// The host also says where its fictional demo listens (#114); the page checks
// that address before offering it as a plain link.

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')
const root = createRoot(container)

const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>)

// 127.0.0.1 is the launch-link origin on the host's own computer; any other name
// is a paired home-network device (#137), which must never be told about the private link.
const onRemotePage = window.location.hostname !== '127.0.0.1'

try {
  const session = await fetchSession()
  const switcher = liveModeSwitch(session.demoUrl, window.location)
  const demoHref = validDemoHref(session.demoUrl, window.location)
  const remote = session.remote === true
  const google = remote && session.auth === 'google'
  if (google) {
    // A page restored from the back/forward cache after sign-out must not show the app.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) window.location.reload()
    })
  }
  if (session.authenticated) {
    const live = createLiveApi({
      csrfToken: session.csrfToken,
      ...(google ? { auth: 'google' as const } : {}),
      onSessionLost: () => render(google ? <GoogleSignIn sessionEnded /> : remote ? <EnrollDevice sessionEnded /> : <LaunchRequired reason="session-ended" demoHref={demoHref} />),
      ...(remote ? { onUnreachable: () => render(<HostUnreachable />) } : {})
    })
    const userName = session.user?.displayName
    const userRole = session.user?.role
    const person: SignedInPerson | null = google && typeof userName === 'string' && isUserRole(userRole) ? { name: userName, role: userRole } : null
    const runtime: AppRuntime = remote
      ? {
          mode: 'live',
          data: live.data,
          backup: null,
          backupStatus: null,
          cases: live.cases,
          switcher,
          remote: true,
          signOut: live.signOut,
          // The server decides what a call may do; the owner's directory is only wired up for owners.
          ...(person ? { account: live.account, person, ...(person.role === 'owner' ? { users: live.users } : {}) } : {})
        }
      : { mode: 'live', data: live.data, backup: live.backup, backupStatus: live.backupStatus, cases: live.cases, switcher, lan: live.lan, users: live.users }
    render(<App runtime={runtime} />)
  } else {
    render(google ? <GoogleSignIn reason={takeSignInReason()} /> : remote ? <EnrollDevice /> : <LaunchRequired reason="signed-out" demoHref={demoHref} />)
  }
} catch {
  render(onRemotePage ? <HostUnreachable /> : <LaunchRequired reason="unreachable" />)
}
