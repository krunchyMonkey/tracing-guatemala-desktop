import { isDemoHostname } from '../../../shared/dns-name'
import type { ModeSwitch } from '../runtime/AppRuntime'

// The Live host reports where its fictional demo mirror listens (#114). The page
// doesn't trust that blindly: it must be http://localhost:<port>/ (optionally
// with `?live=<port>`), nothing else, and the link is rebuilt from the parsed
// parts. Anything unexpected means "no demo link".
//
// On a paired home-network device (#137) the page is not on the host's
// computer, so a localhost link would open the device's own localhost. There the
// only accepted form is the LAN demo: http://<dns name>:<port>/ with a name (not
// an IP) that differs from the page's own host, so it is a different site.

const LIVE_PARAM = /^\?live=[1-9]\d{3,4}$/

/** The page's own host name; a name other than `127.0.0.1` means this is a paired device (#137). */
export interface PageLocation {
  hostname: string
}

const isRemotePage = (page: PageLocation) => page.hostname !== '127.0.0.1'

function validLanDemoHref(url: URL, page: PageLocation): string | null {
  if (url.protocol !== 'http:' || !isDemoHostname(url.hostname) || url.hostname === page.hostname.toLowerCase()) return null
  if (!/^\d+$/.test(url.port)) return null
  const port = Number(url.port)
  if (port < 1024 || port > 65535) return null
  if (url.pathname !== '/' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  return `http://${url.hostname}:${port}/`
}

/** The safe demo address for `value` (as sent by the host), or null. Without `page` this is the loopback form. */
export function validDemoHref(value: unknown, page?: PageLocation): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (page && isRemotePage(page)) return validLanDemoHref(url, page)
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !/^\d+$/.test(url.port)) return null
  const port = Number(url.port)
  if (port < 1024 || port > 65535) return null
  if (url.pathname !== '/' || url.username !== '' || url.password !== '' || url.hash !== '') return null
  if (url.search !== '' && !LIVE_PARAM.test(url.search)) return null
  return `http://localhost:${port}/${url.search}`
}

export function liveModeSwitch(demoUrl: unknown, page?: PageLocation): ModeSwitch {
  const href = validDemoHref(demoUrl, page)
  return href ? { kind: 'link', href } : { kind: 'unavailable', reason: 'not-available' }
}
