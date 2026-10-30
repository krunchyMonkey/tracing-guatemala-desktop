import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DatabaseTooNewError } from '../main/database/migrations'
import { DataDirInUseError, defaultLiveDataDir } from './data-dir'
import { startDemoMirror, type RunningDemoMirror } from './demo-mirror'
import { DEFAULT_LIVE_PORT, startLiveServer } from './server'

// `npm run web:local [-- --port <n>] [-- --data-dir <folder>] [-- --no-demo]`:
// the persistent Live web app on this computer only (#110). Built by
// `npm run web:build` into dist-web/server/main.mjs, next to the client in
// dist-web/client/. Unless --no-demo is given it also serves the fictional demo
// (dist-demo/) on the next port as http://localhost:<port + 1>/ (#114).

declare const __APP_VERSION__: string

const { values } = parseArgs({
  options: { port: { type: 'string' }, 'data-dir': { type: 'string' }, 'no-demo': { type: 'boolean' } }
})
const port = Number(values.port ?? process.env['TG_WEB_PORT'] ?? DEFAULT_LIVE_PORT)
const dataDir = resolve(values['data-dir'] ?? process.env['TG_WEB_DATA_DIR'] ?? defaultLiveDataDir())
const staticDir = fileURLToPath(new URL('../client/', import.meta.url))
const demoDir = fileURLToPath(new URL('../../dist-demo/', import.meta.url))

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('The port must be a whole number from 1024 to 65535.')
  process.exit(1)
}
if (!existsSync(join(staticDir, 'index.html'))) {
  console.error('The web app is not built. Run `npm run web:build` first.')
  process.exit(1)
}

// The demo is a convenience: whatever goes wrong here, Live still starts without it.
let mirror: RunningDemoMirror | null = null
let demoNote = 'Fictional demo: not served (--no-demo).'
if (!values['no-demo']) {
  try {
    mirror = await startDemoMirror({ port: port + 1, demoDir })
    demoNote = mirror
      ? `Fictional demo on this computer: ${mirror.origin}/`
      : 'Fictional demo: not served (run `npm run web:build` to include it).'
  } catch (error) {
    demoNote =
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Fictional demo: not served (port ${port + 1} is in use). Live works without it.`
        : 'Fictional demo: not served (it could not start). Live works without it.'
  }
}

let server: Awaited<ReturnType<typeof startLiveServer>>
try {
  server = await startLiveServer({
    dataDir,
    port,
    staticDir,
    demoUrl: mirror ? `${mirror.origin}/?live=${port}` : null,
    appInfo: { name: 'Tracing Guatemala', version: __APP_VERSION__, platform: 'web' }
  })
} catch (error) {
  await mirror?.close()
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

  ${demoNote}

  Don't share the link: it signs the browser in. It stops working when this
  window is closed. Press Ctrl+C to stop.
`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.all([server.close(), mirror?.close()]).finally(() => {
      console.log('Tracing Guatemala stopped. Your data is saved.')
      process.exit(0)
    })
  })
}
