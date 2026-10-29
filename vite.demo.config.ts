import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { buildContentSecurityPolicy } from './src/shared/csp'

// Browser-only build of the shared React UI for the LAN demo (#100): no Electron,
// no preload, fictional in-memory data. `npm run demo:build` writes dist-demo/;
// `npm run demo:lan` (scripts/demo-lan.mjs) serves it over plain HTTP.

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const { version } = JSON.parse(readFileSync(fromRoot('./package.json'), 'utf8')) as { version: string }

// The demo has no backend, so it gets the desktop production policy: only its
// own scripts and styles, and no network connections at all.
function injectDemoCsp(): Plugin {
  return {
    name: 'tracing-guatemala:inject-demo-csp',
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
  root: fromRoot('./src/renderer/demo'),
  base: './',
  plugins: [react(), injectDemoCsp()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: fromRoot('./dist-demo'),
    emptyOutDir: true
  },
  // `npm run demo:dev`: hot reload on this computer only (Vite's default localhost binding).
  server: { port: 5174, strictPort: true },
  // Host and port come from scripts/demo-lan.mjs. Vite's host check and
  // localhost-only CORS defaults stay on.
  preview: {
    port: 4173,
    strictPort: true,
    headers: {
      'Content-Security-Policy': buildContentSecurityPolicy({ mode: 'production' }),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    }
  }
})
