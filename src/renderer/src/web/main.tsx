import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import type { AppRuntime } from '../runtime/AppRuntime'
import '../styles.css'
import { liveModeSwitch, validDemoHref } from './demoLink'
import { EnrollDevice } from './EnrollDevice'
import { LaunchRequired } from './LaunchRequired'
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

try {
  const session = await fetchSession()
  const switcher = liveModeSwitch(session.demoUrl)
  const demoHref = validDemoHref(session.demoUrl)
  const remote = session.remote === true
  if (session.authenticated) {
    const live = createLiveApi({
      csrfToken: session.csrfToken,
      onSessionLost: () => render(remote ? <EnrollDevice /> : <LaunchRequired reason="session-ended" demoHref={demoHref} />)
    })
    const runtime: AppRuntime = remote
      ? { mode: 'live', data: live.data, backup: null, backupStatus: null, cases: live.cases, switcher, remote: true, signOut: live.signOut }
      : { mode: 'live', data: live.data, backup: live.backup, backupStatus: live.backupStatus, cases: live.cases, switcher, lan: live.lan }
    render(<App runtime={runtime} />)
  } else {
    render(remote ? <EnrollDevice /> : <LaunchRequired reason="signed-out" demoHref={demoHref} />)
  }
} catch {
  render(<LaunchRequired reason="unreachable" />)
}
