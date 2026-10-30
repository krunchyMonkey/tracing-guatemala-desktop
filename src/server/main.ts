import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DatabaseTooNewError } from '../main/database/migrations'
import { DataDirInUseError, defaultLiveDataDir } from './data-dir'
import { LanHostError } from './lan'
import { initLanTestProfile } from './lan-profile'
import { startDemoMirror, type RunningDemoMirror } from './demo-mirror'
import { openInBrowser } from './open-browser'
import { DEFAULT_LIVE_PORT, startLiveServer } from './server'

// `npm run web:local [-- --port <n>] [-- --data-dir <folder>] [-- --open] [-- --no-demo] [-- --lan-host <address>]`:
// the persistent Live web app on this computer only (#110); --open also opens the
// private link in the default browser (#117, `npm run live`). Built by
// `npm run web:build` into dist-web/server/main.mjs, next to the client in
// dist-web/client/. Unless --no-demo is given it also serves the fictional demo
// (dist-demo/) on the next port as http://localhost:<port + 1>/ (#114).
// --lan-host <private IPv4 address of this computer> adds an opt-in, unencrypted
// home-network listener (#135) for paired devices (#136). It is unencrypted, so it
// only starts on a folder marked as fictional test data, made once with
// --init-lan-test-profile --data-dir <new folder>. It is a flag and not an
// environment variable so nothing can switch it on by accident.
// --lan-demo-name <host name> (#137, needs --lan-host, ignored with --no-demo) also
// serves the fictional demo on the LAN address at port + 1, reached by that name
// (which must resolve to the LAN address) so Live and the demo are different
// sites. If it can't be served, Live still starts and the console says why.
// Test only: TG_TEST_HOOKS=1 with TG_TEST_RESOLVE=<name>=<address> makes that
// name resolve server-side without touching DNS; it does nothing otherwise.

declare const __APP_VERSION__: string

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    open: { type: 'boolean', default: false },
    'no-demo': { type: 'boolean' },
    'lan-host': { type: 'string' },
    'lan-demo-name': { type: 'string' },
    'init-lan-test-profile': { type: 'boolean' }
  }
})
const port = Number(values.port ?? process.env['TG_WEB_PORT'] ?? DEFAULT_LIVE_PORT)
const dataDir = resolve(values['data-dir'] ?? process.env['TG_WEB_DATA_DIR'] ?? defaultLiveDataDir())
const lanHost = values['lan-host'] ?? null
const lanDemoName = values['lan-demo-name'] ?? null
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

if (lanDemoName !== null && !lanHost) {
  console.error('--lan-demo-name needs --lan-host <address>: the demo is served on that home-network address.')
  process.exit(1)
}

// Strictly test-gated: without TG_TEST_HOOKS=1 the system resolver is always used.
let lanDemoResolve: ((name: string) => Promise<string[]>) | undefined
if (process.env['TG_TEST_HOOKS'] === '1' && process.env['TG_TEST_RESOLVE']) {
  const [testName, testAddress] = process.env['TG_TEST_RESOLVE'].split('=')
  if (testName && testAddress) {
    console.warn('TEST HOOK ACTIVE: a demo name is resolved from TG_TEST_RESOLVE. Never set TG_TEST_HOOKS outside automated tests.')
    lanDemoResolve = async (name) => {
      if (name !== testName) throw new Error('unresolved')
      return [testAddress]
    }
  }
}

if (values['init-lan-test-profile']) {
  if (!lanHost || !values['data-dir']) {
    console.error('--init-lan-test-profile needs both --lan-host <address> and an explicit --data-dir <new folder>. It prepares a profile for fictional test data only.')
    process.exit(1)
  }
  try {
    initLanTestProfile(dataDir)
  } catch (error) {
    console.error(error instanceof LanHostError ? error.message : 'The test profile could not be prepared. Nothing was started.')
    process.exit(1)
  }
  console.log('Prepared a fictional-test-data profile. Use it for fictional data only: HTTP on the home network is unencrypted.')
}

// The demo is a convenience: whatever goes wrong here, Live still starts without it.
let mirror: RunningDemoMirror | null = null
let demoNote = 'Fictional demo: not served (--no-demo).'
if (!values['no-demo']) {
  try {
    mirror = await startDemoMirror({ port: port + 1, demoDir })
    demoNote = mirror ? `Fictional demo on this computer: ${mirror.origin}/` : 'Fictional demo: not served (run `npm run web:build` to include it).'
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
    lanHost,
    lanDemoName: values['no-demo'] ? null : lanDemoName,
    demoDir,
    ...(lanDemoResolve ? { lanDemoResolve } : {}),
    demoUrl: mirror ? `${mirror.origin}/?live=${port}` : null,
    appInfo: { name: 'Tracing Guatemala', version: __APP_VERSION__, platform: 'web' }
  })
} catch (error) {
  await mirror?.close()
  // Only messages written by this app are shown; SQLite messages can quote stored values.
  if (error instanceof DataDirInUseError) console.error('Tracing Guatemala is already running with this data. Use that window, or stop it first.')
  else if (error instanceof DatabaseTooNewError) console.error('This data was saved by a newer version of Tracing Guatemala. Nothing was changed.')
  else if (error instanceof LanHostError) console.error(error.message)
  else if (
    lanHost &&
    ['EADDRNOTAVAIL', 'EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') &&
    (error as { address?: unknown }).address === lanHost
  ) {
    console.error(
      `The home-network address ${lanHost}:${port} could not be used (it is busy or no longer available). Nothing was started. If the computer's network address changed, restart with the new --lan-host address; paired devices pair again.`
    )
  } else if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`Port ${port} is in use. Stop the other program or use --port <n>.`)
  else if (error instanceof Error && error.message.startsWith('That ')) console.error(error.message)
  else console.error(`The web app could not start: ${error instanceof Error ? error.name : 'unknown error'}. Nothing was changed.`)
  process.exit(1)
}

const lanNote = server.lanOrigin
  ? `
  Home network (opt-in): ${server.lanOrigin}/
    UNENCRYPTED HTTP, trusted home network only. Anyone on this network can read
    or change the traffic, including pairing codes and sessions. FICTIONAL TEST
    DATA ONLY. Pair a device from Settings on this computer: the pairing code is
    shown there. Pairing controls who can sign in; it does not encrypt anything.
    Never forward this port on your router or expose it to the internet.
    Turn it off from Settings on this computer, or stop this window. Restart with
    --lan-host to turn it on again.
${
    server.lanDemoUrl
      ? `    Fictional demo on the home network: ${server.lanDemoUrl}
`
      : lanDemoName && !values['no-demo']
        ? `    Fictional demo on the home network: not served (${server.lanDemoNote ?? 'unknown reason'}). Live works without it.
`
        : ''
  }`
  : ''

console.log(`
Tracing Guatemala — Live (${server.lanOrigin ? 'fictional test data; the private link works on this computer only' : 'your real data, this computer only'})

  Open this private link in your browser on THIS computer:
    ${server.launchUrl}

  ${demoNote}
${lanNote}
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
    void Promise.all([server.close(), mirror?.close()]).finally(() => {
      console.log('Tracing Guatemala stopped. Your data is saved.')
      process.exit(0)
    })
  })
}
