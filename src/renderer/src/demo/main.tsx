import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import type { AppRuntime } from '../runtime/AppRuntime'
import { DemoToolsProvider } from '../components/DemoTools'
import { GuidanceProvider } from '../guidance/GuidanceContext'
import '../styles.css'
import { DemoToolbar } from './DemoToolbar'
import { demoGuides } from './demoTour'
import { createDemoApi, defaultClock } from './demoApi'
import { createDemoCases } from './demoCases'
import { demoModeSwitch } from './modeLink'
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
  ),
  // Decided from this page's own address only; the demo makes no network calls (#114).
  switcher: demoModeSwitch(window.location)
}

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

// Driver.js is a separate chunk, loaded only here: the Live web app and the desktop
// app never import this entry, so they never contain it (#102).
const { createDriverJsGuidanceService } = await import('../guidance/driverJsProvider')
const guidance = createDriverJsGuidanceService({ guides: demoGuides })

createRoot(container).render(
  <StrictMode>
    <GuidanceProvider service={guidance}>
      <DemoToolsProvider tools={<DemoToolbar />}>
        <App runtime={runtime} />
      </DemoToolsProvider>
    </GuidanceProvider>
  </StrictMode>
)
