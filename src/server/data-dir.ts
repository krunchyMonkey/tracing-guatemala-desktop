import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Where the Live web host keeps its data (#110). It is a separate profile from
// the desktop app: the host never opens, migrates or replaces the Electron
// database. Moving desktop data over is an explicit backup + restore.

export const WEB_PROFILE_NAME = 'Tracing Guatemala Web'
/** Electron's per-user data folder is named after productName in package.json. */
const DESKTOP_PROFILE_NAME = 'Tracing Guatemala'

interface Platform {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}

const currentPlatform = (): Platform => ({ platform: process.platform, env: process.env, home: homedir() })

/** The OS folder that holds per-user application data (where Electron's appData points). */
function appDataRoot({ platform, env, home }: Platform): string {
  if (platform === 'win32') return env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  return env['XDG_CONFIG_HOME'] ?? join(home, '.config')
}

/** Default Live data folder, next to (never inside) the desktop app's. */
export function defaultLiveDataDir(platform: Platform = currentPlatform()): string {
  return join(appDataRoot(platform), WEB_PROFILE_NAME)
}

/** The desktop app's per-user data folder, which the web host must never use. */
export function desktopProfileDir(platform: Platform = currentPlatform()): string {
  return join(appDataRoot(platform), DESKTOP_PROFILE_NAME)
}

const sameDir = (a: string, b: string, platform: NodeJS.Platform) =>
  platform === 'win32' || platform === 'darwin' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

/**
 * Refuses the desktop app's profile, and any folder that looks like an Electron
 * or Chromium profile, so the web host can't silently share or migrate it.
 */
export function checkLiveDataDir(dir: string, platform: Platform = currentPlatform()): { ok: true } | { ok: false; error: string } {
  if (sameDir(dir, desktopProfileDir(platform), platform.platform)) {
    return { ok: false, error: 'That is the desktop app’s data folder. The web app keeps its own data; use a backup to copy data across.' }
  }
  if (['Local State', 'Preferences', 'Local Storage'].some((marker) => existsSync(join(dir, marker)))) {
    return { ok: false, error: 'That folder belongs to another application. Choose an empty or web-app data folder.' }
  }
  return { ok: true }
}

/** Another host already holds this data folder. */
export class DataDirInUseError extends Error {
  constructor() {
    super('Another Tracing Guatemala web host is already using this data folder')
    this.name = 'DataDirInUseError'
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Folders locked by this process, so a second host in the same process is refused too. */
const heldHere = new Set<string>()

/**
 * Takes an exclusive lock on the data folder, so two hosts never open (or
 * restore over) the same database. A lock left by a process that is no longer
 * running is replaced. Returns the release function.
 */
export function acquireDataDirLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true })
  const key = resolve(dir).toLowerCase()
  if (heldHere.has(key)) throw new DataDirInUseError()
  const lockFile = join(dir, 'web-host.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      heldHere.add(key)
      let released = false
      return () => {
        if (released) return
        released = true
        heldHere.delete(key)
        rmSync(lockFile, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = Number(readFileSync(lockFile, 'utf8').trim())
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && processIsRunning(holder)) {
        throw new DataDirInUseError()
      }
      rmSync(lockFile, { force: true })
    }
  }
  throw new DataDirInUseError()
}
