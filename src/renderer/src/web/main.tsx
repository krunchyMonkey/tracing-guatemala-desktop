import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import type { AppRuntime } from '../runtime/AppRuntime'
import '../styles.css'
import { LaunchRequired } from './LaunchRequired'
import { createLiveApi, fetchSession } from './liveApi'

// Entry point of the Live web app (#110, vite.web.config.ts): the shared UI
// over the loopback local web host. Without a session (the browser didn't come
// through the launch link, or the host restarted) it only explains what to do.

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')
const root = createRoot(container)

const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>)

try {
  const session = await fetchSession()
  if (session.authenticated) {
    const live = createLiveApi({
      csrfToken: session.csrfToken,
      onSessionLost: () => render(<LaunchRequired reason="session-ended" />)
    })
    const runtime: AppRuntime = { mode: 'live', ...live }
    render(<App runtime={runtime} />)
  } else {
    render(<LaunchRequired reason="signed-out" />)
  }
} catch {
  render(<LaunchRequired reason="unreachable" />)
}
