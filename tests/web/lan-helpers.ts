import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Shared by the home-network Live browser specs (#137, #138): this computer's
// private IPv4 address (discovered at run time, never written down), free port
// pairs, and the built host started and stopped as a child process. Fictional
// data only. Not a spec file, so Playwright does not run it.

export const root = resolve(__dirname, '../..')
export const DEMO_NAME = 'tg-demo.test'
export const HTTP_TEXT = 'Unencrypted HTTP — trusted home network only'
export const channel = process.platform === 'win32' ? 'msedge' : undefined

const addresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((e) => e.family === 'IPv4' && !e.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address))
  .map((e) => e.address)
/** This computer's private IPv4 address, or undefined when it has none or several share one. */
export const lanIp: string | undefined = addresses.find((address) => addresses.filter((a) => a === address).length === 1)

export interface Host {
  child: ChildProcess
  launchUrl: string
  output: () => string
}

const running: ChildProcess[] = []
const folders: string[] = []

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise<number>((done, fail) => {
      const probe = createServer()
      probe.once('error', fail)
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port
        probe.close(() => done(p))
      })
    })
    // Both the Live port and port + 1 (the demo) must be free on both interfaces.
    const free = async (host: string, p: number) =>
      new Promise<boolean>((done) => {
        const probe = createServer()
        probe.once('error', () => done(false))
        probe.listen(p, host, () => probe.close(() => done(true)))
      })
    if ((await free('127.0.0.1', port)) && (await free('127.0.0.1', port + 1)) && (await free(lanIp!, port)) && (await free(lanIp!, port + 1))) return port
  }
  throw new Error('no free port pair')
}

export interface StartOptions {
  /** Start with the home-network listener. */
  withLan: boolean
  /** An existing profile folder (a restart). Without it a new folder is made. */
  dataDir?: string
  /** Mark a new profile (--init-lan-test-profile); leave out when restarting. Default: true for a new folder. */
  init?: boolean
  /** Also serve the LAN demo under DEMO_NAME. Default true. */
  demo?: boolean
}

export async function startHost(port: number, options: StartOptions): Promise<{ host: Host; dataDir: string }> {
  let dataDir = options.dataDir
  if (!dataDir) {
    const parent = mkdtempSync(join(tmpdir(), 'tg-lan-e2e-'))
    folders.push(parent)
    dataDir = join(parent, 'profile')
  }
  const init = options.init ?? !options.dataDir
  const args = ['--disable-warning=ExperimentalWarning', 'dist-web/server/main.mjs', '--port', String(port), '--data-dir', dataDir]
  if (options.withLan) {
    args.push('--lan-host', lanIp!)
    if (init) args.push('--init-lan-test-profile')
    if (options.demo !== false) args.push('--lan-demo-name', DEMO_NAME)
  }
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, TG_TEST_HOOKS: '1', TG_TEST_RESOLVE: `${DEMO_NAME}=${lanIp}` }
  })
  running.push(child)
  let output = ''
  const launchUrl = await new Promise<string>((ready, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = /http:\/\/127\.0\.0\.1:\d+\/launch\?token=[\w-]+/.exec(output)
      if (match && output.includes('Press Ctrl+C to stop')) ready(match[0])
    })
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('exit', (code) => fail(new Error(`web:local exited with ${code}: ${output}`)))
  })
  return { host: { child, launchUrl, output: () => output }, dataDir }
}

export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  child.kill()
  await exited
}

/** Stops every host started here and deletes the throwaway profiles. */
export async function cleanupHosts(): Promise<void> {
  await Promise.all(running.splice(0).map(stop))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
}
