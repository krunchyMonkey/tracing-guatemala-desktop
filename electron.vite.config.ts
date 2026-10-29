import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { buildContentSecurityPolicy } from './src/shared/csp'

// Production builds also carry the CSP as a <meta> tag (defense in depth). The
// authoritative policy is the response header set by the app:// protocol handler.
function injectProductionCsp(): Plugin {
  return {
    name: 'tracing-guatemala:inject-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: buildContentSecurityPolicy({ mode: 'production', forMetaTag: true })
          },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {},
  preload: {
    // Sandboxed preloads cannot require() packages from node_modules, so bundle everything.
    build: { externalizeDeps: false }
  },
  renderer: {
    plugins: [react(), injectProductionCsp()]
  }
})
