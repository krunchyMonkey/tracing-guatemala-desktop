// Starts the Live web app and opens it in the browser (#117):
//   npm run live [-- --port <n>] [-- --data-dir <folder>]
// Builds the app first only if it has never been built. Ctrl+C stops it. The
// launchers (Start Tracing Guatemala.cmd, start-tracing-guatemala.sh) do the
// same without needing npm to be run by hand.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const host = join(root, 'dist-web', 'server', 'main.mjs')

if (!existsSync(host)) {
  console.log('Building Tracing Guatemala for the first time (this takes a minute)…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // npm.cmd needs a shell on Windows; the arguments are fixed.
  const built = spawnSync(npm, ['run', 'web:build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0 || !existsSync(host)) {
    console.error('The build failed. Run `npm install`, then try again.')
    process.exit(1)
  }
}

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', host, '--open', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit'
})

// The terminal delivers Ctrl+C to this process and the host alike on Windows,
// where forwarding would end the host abruptly; elsewhere forward it so a signal
// sent only to this process still stops the host cleanly. The host stops once.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (process.platform !== 'win32') child.kill(signal)
  })
}
child.once('error', () => {
  console.error('Tracing Guatemala could not be started.')
  process.exit(1)
})
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
