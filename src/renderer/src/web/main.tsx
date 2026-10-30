import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import type { AppRuntime } from '../runtime/AppRuntime'
import '../styles.css'
import { liveModeSwitch, validDemoHref } from './demoLink'
import { LaunchRequired } from './LaunchRequired'
import { createLiveApi, fetchSession } from './liveApi'

// Entry point of the Live web app (#110, vite.web.config.ts): the shared UI
// over the loopback local web host. Without a session (the browser didn't come
// through the launch link, or the host restarted) it only explains what to do.
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
  if (session.authenticated) {
    const live = createLiveApi({
      csrfToken: session.csrfToken,
      onSessionLost: () => render(<LaunchRequired reason="session-ended" demoHref={demoHref} />)
    })
    const runtime: AppRuntime = { mode: 'live', ...live, switcher }
    render(<App runtime={runtime} />)
  } else {
    render(<LaunchRequired reason="signed-out" demoHref={demoHref} />)
  }
} catch {
  render(<LaunchRequired reason="unreachable" />)
}
