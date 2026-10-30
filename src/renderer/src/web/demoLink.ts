import type { ModeSwitch } from '../runtime/AppRuntime'

// The Live host reports where its fictional demo mirror listens (#114). The page
// doesn't trust that blindly: it must be http://localhost:<port>/ (optionally
// with `?live=<port>`), nothing else, and the link is rebuilt from the parsed
// parts. Anything unexpected means "no demo link".

const LIVE_PARAM = /^\?live=[1-9]\d{3,4}$/

/** The safe demo address for `value` (as sent by the host), or null. */
export function validDemoHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !/^\d+$/.test(url.port)) return null
  const port = Number(url.port)
  if (port < 1024 || port > 65535) return null
  if (url.pathname !== '/' || url.username !== '' || url.password !== '' || url.hash !== '') return null
  if (url.search !== '' && !LIVE_PARAM.test(url.search)) return null
  return `http://localhost:${port}/${url.search}`
}

export function liveModeSwitch(demoUrl: unknown): ModeSwitch {
  const href = validDemoHref(demoUrl)
  return href ? { kind: 'link', href } : { kind: 'unavailable', reason: 'not-available' }
}
