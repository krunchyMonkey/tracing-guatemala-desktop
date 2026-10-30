import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import type { AppRuntime } from '../runtime/AppRuntime'
import '../styles.css'
import { createDemoApi, defaultClock } from './demoApi'
import { createDemoCases } from './demoCases'
import { buildDemoCases, buildDemoData } from './sampleData'

// Entry point of the browser demo (#100, vite.demo.config.ts). Same UI as the
// desktop app; data lives in this page's memory, so a refresh resets it.

const data = createDemoApi(buildDemoData(), {
  name: 'Tracing Guatemala browser demo',
  version: __APP_VERSION__,
  platform: 'browser'
})

const runtime: AppRuntime = {
  mode: 'demo',
  data,
  backup: null,
  // Cases read client status through the same demo clients, so archiving a client locks its cases.
  cases: createDemoCases(buildDemoCases(), data.getClient, defaultClock, () =>
    data.listClients({ text: '', status: 'all', sources: [], sort: 'name' })
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>
)
