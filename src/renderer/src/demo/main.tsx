import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import type { AppRuntime } from '../runtime/AppRuntime'
import '../styles.css'
import { createDemoApi } from './demoApi'
import { demoModeSwitch } from './modeLink'
import { buildDemoData } from './sampleData'

// Entry point of the browser demo (#100, vite.demo.config.ts). Same UI as the
// desktop app; data lives in this page's memory, so a refresh resets it.

const runtime: AppRuntime = {
  mode: 'demo',
  data: createDemoApi(buildDemoData(), {
    name: 'Tracing Guatemala browser demo',
    version: __APP_VERSION__,
    platform: 'browser'
  }),
  backup: null,
  // Decided from this page's own address only; the demo makes no network calls (#114).
  switcher: demoModeSwitch(window.location)
}

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>
)
