import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { buildContentSecurityPolicy } from './src/shared/csp'
import { openLiveHost } from './src/server/server'

// The Live web app (#110): the shared React UI over the loopback local web host.
// `npm run web:dev` serves it with hot reload and mounts the host's API in the
// same dev server, using a throwaway profile in .web-dev-data/ (never your real
// data). `npm run web:build` writes the client to dist-web/client/ and, with
// vite.web-host.config.ts, the host to dist-web/server/.

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const { version } = JSON.parse(readFileSync(fromRoot('./package.json'), 'utf8')) as { version: string }

export const WEB_DEV_PORT = 5175

// Same policy as the desktop app, except the page may fetch its own origin (the API).
function injectWebCsp(): Plugin {
  return {
    name: 'tracing-guatemala:inject-web-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: buildContentSecurityPolicy({ mode: 'production', forMetaTag: true, connectToSelf: true })
          },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

// Vite re-runs configureServer when it restarts, possibly before closing the old
// server, so the previous host (and its data folder lock) is closed first.
const previousHost = Symbol.for('tracing-guatemala:live-host-dev')
type WithPrevious = typeof globalThis & { [previousHost]?: { close: () => void } }

function liveHostInDevServer(): Plugin {
  return {
    name: 'tracing-guatemala:live-host-dev',
    apply: 'serve',
    configureServer(server) {
      ;(globalThis as WithPrevious)[previousHost]?.close()
      const opened = openLiveHost({
        dataDir: process.env['TG_WEB_DEV_DATA_DIR'] ?? fromRoot('./.web-dev-data'),
        port: WEB_DEV_PORT,
        staticDir: null,
        appInfo: { name: 'Tracing Guatemala (development)', version, platform: 'web' }
      })
      ;(globalThis as WithPrevious)[previousHost] = opened
      server.middlewares.use((req, res, next) => {
        if (!opened.host.handle(req, res)) next()
      })
      server.httpServer?.once('listening', () => {
        server.config.logger.info(
          `\n  Live dev link (sign in with this): http://127.0.0.1:${WEB_DEV_PORT}${opened.host.launchPath}\n  Data: .web-dev-data/ (development only, fictional data)\n`
        )
      })
      server.httpServer?.once('close', () => opened.close())
    }
  }
}

export default defineConfig({
  root: fromRoot('./src/renderer/web'),
  base: '/',
  plugins: [react(), injectWebCsp(), liveHostInDevServer()],
  build: {
    outDir: fromRoot('./dist-web/client'),
    emptyOutDir: true
  },
  // Loopback only, like the production host.
  server: { host: '127.0.0.1', port: WEB_DEV_PORT, strictPort: true }
})
