// Packaged-build SQLite smoke test (#5). Run after `npm run package:dir`:
//   npm run smoke:packaged
// Launches the packaged app twice against a throwaway profile (--user-data-dir)
// and checks that it creates, migrates and reopens its database. Playwright
// cannot drive the packaged app because the inspect/run-as-node fuses are off,
// so this observes the database file instead. Fictional data only.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

const EXPECTED_VERSION = 2
const root = resolve(import.meta.dirname, '..')
const executables = {
  win32: 'release/win-unpacked/Tracing Guatemala.exe',
  linux: 'release/linux-unpacked/tracing-guatemala-desktop',
  darwin: 'release/mac/Tracing Guatemala.app/Contents/MacOS/Tracing Guatemala'
}
const exe = join(root, executables[process.platform] ?? '')
if (!existsSync(exe)) throw new Error(`Packaged app not found at ${exe}; run npm run package:dir first`)

const userData = mkdtempSync(join(tmpdir(), 'tg-packaged-smoke-'))
const dbFile = join(userData, 'data', 'tracing-guatemala.sqlite')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function readDb(fn) {
  const db = new DatabaseSync(dbFile)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

async function runApp(label, check) {
  const child = spawn(exe, [`--user-data-dir=${userData}`], { env, stdio: 'ignore' })
  let exitCode = null
  child.on('exit', (code) => (exitCode = code))
  try {
    // A failed database open shows an error dialog and exits, so the app must still be running.
    await sleep(6000)
    if (exitCode !== null) throw new Error(`${label}: app exited early with code ${exitCode}`)
    const version = existsSync(dbFile) ? readDb((db) => db.prepare('PRAGMA user_version').get().user_version) : null
    if (version !== EXPECTED_VERSION) throw new Error(`${label}: expected schema version ${EXPECTED_VERSION}, found ${version}`)
    check()
    console.log(`ok  ${label}`)
  } finally {
    child.kill()
    await sleep(1000)
  }
}

try {
  await runApp('first launch creates and migrates the database', () => undefined)
  readDb((db) =>
    db
      .prepare(
        `INSERT INTO clients (id, display_name, source, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-0000000000aa', 'Packaged Smoke Fictional', 'direct',
                 '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z')`
      )
      .run()
  )
  await runApp('relaunch reopens the existing database and keeps its data', () => {
    const count = readDb((db) => db.prepare('SELECT count(*) AS n FROM clients').get().n)
    if (count !== 1) throw new Error(`expected 1 client after relaunch, found ${count}`)
  })
  console.log('packaged SQLite smoke passed')
} finally {
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
