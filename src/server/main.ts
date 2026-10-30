import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DatabaseTooNewError } from '../main/database/migrations'
import { DataDirInUseError, defaultLiveDataDir } from './data-dir'
import { openInBrowser } from './open-browser'
import { DEFAULT_LIVE_PORT, startLiveServer } from './server'

// `npm run web:local [-- --port <n>] [-- --data-dir <folder>] [-- --open]`: the persistent
// Live web app on this computer only (#110); --open also opens the private
// link in the default browser (#117, `npm run live`). Built by `npm run web:build` into
// dist-web/server/main.mjs, next to the client in dist-web/client/.

declare const __APP_VERSION__: string

const { values } = parseArgs({
  options: { port: { type: 'string' }, 'data-dir': { type: 'string' }, open: { type: 'boolean', default: false } }
})
const port = Number(values.port ?? process.env['TG_WEB_PORT'] ?? DEFAULT_LIVE_PORT)
const dataDir = resolve(values['data-dir'] ?? process.env['TG_WEB_DATA_DIR'] ?? defaultLiveDataDir())
const staticDir = fileURLToPath(new URL('../client/', import.meta.url))

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('The port must be a whole number from 1024 to 65535.')
  process.exit(1)
}
if (!existsSync(join(staticDir, 'index.html'))) {
  console.error('The web app is not built. Run `npm run web:build` first.')
  process.exit(1)
}

let server: Awaited<ReturnType<typeof startLiveServer>>
try {
  server = await startLiveServer({
    dataDir,
    port,
    staticDir,
    appInfo: { name: 'Tracing Guatemala', version: __APP_VERSION__, platform: 'web' }
  })
} catch (error) {
  // Only messages written by this app are shown; SQLite messages can quote stored values.
  if (error instanceof DataDirInUseError) console.error('Tracing Guatemala is already running with this data. Use that window, or stop it first.')
  else if (error instanceof DatabaseTooNewError) console.error('This data was saved by a newer version of Tracing Guatemala. Nothing was changed.')
  else if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`Port ${port} is in use. Stop the other program or use --port <n>.`)
  else if (error instanceof Error && error.message.startsWith('That ')) console.error(error.message)
  else console.error(`The web app could not start: ${error instanceof Error ? error.name : 'unknown error'}. Nothing was changed.`)
  process.exit(1)
}

console.log(`
Tracing Guatemala — Live (your real data, this computer only)

  Open this private link in your browser on THIS computer:
    ${server.launchUrl}

  Don't share the link: it signs the browser in. It stops working when this
  window is closed. Press Ctrl+C to stop.
`)

// Only after a successful start: every failure above exits without opening anything.
if (values.open) {
  const opened = openInBrowser(server.launchUrl, () => console.log('Your browser could not be opened. Open the private link above yourself.'))
  if (opened) console.log('Opening your browser…')
}

// A launcher may forward the signal the terminal already delivered, so stop only once.
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void server.close().finally(() => {
      console.log('Tracing Guatemala stopped. Your data is saved.')
      process.exit(0)
    })
  })
}
