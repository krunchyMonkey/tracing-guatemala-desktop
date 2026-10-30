import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

// `--open` (#117): opens the private launch link in the default browser. The
// link is made by this host, but it is checked again before anything is run,
// and the command is started without a shell with the link as one argument, so
// nothing in it can be interpreted as a command.

/** Only a plain loopback address with a port: no credentials, no other host. */
export function isLaunchUrl(url: string): boolean {
  if (!url.startsWith('http://127.0.0.1:')) return false
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      parsed.port !== '' &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

export interface OpenCommand {
  command: string
  args: string[]
}

/** The OS command that opens `url` in the default browser, or null if the link isn't a launch link. */
export function openCommand(url: string, platform: NodeJS.Platform = process.platform): OpenCommand | null {
  if (!isLaunchUrl(url)) return null
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'darwin') return { command: 'open', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * Starts the browser and returns without waiting for it. `onFailure` is called
 * if it can't be started (the link is already printed, so that is all it needs
 * to say). Returns false if the link was refused.
 */
export function openInBrowser(url: string, onFailure: () => void, spawnImpl: Spawn = spawn): boolean {
  const open = openCommand(url)
  if (!open) return false
  try {
    const child = spawnImpl(open.command, open.args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false })
    child.once('error', onFailure)
    child.unref()
  } catch {
    onFailure()
  }
  return true
}
