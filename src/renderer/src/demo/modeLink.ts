import type { ModeSwitch } from '../runtime/AppRuntime'

// Where "Back to Live" may point (#114), decided only from the demo page's own
// address: no network, no build-time URL. The Live host and the demo mirror are
// both on the researcher's computer, so the link is offered only when this page
// itself was opened on that computer (loopback) with a valid `?live=<port>`.
// On a LAN address the same page is on someone else's phone or tablet: a link to
// "127.0.0.1" would open that device's own localhost, so none is ever offered.
//
// The LAN demo (#137) is the one exception: the host serves it at a DNS name with
// `<meta name="tg-live-url" content="http://<private IPv4>:<port>/">` in
// index.html, which is trusted server configuration (never a URL parameter). On a
// non-loopback page that address is validated strictly and linked; on a loopback
// page the meta is ignored and the rule above applies.

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1']
const PORT_PARAM = /^[1-9]\d{3,4}$/
const LIVE_URL = /^http:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):([1-9]\d{3,4})\/$/

function isPrivateIPv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) return false
  const [a, b] = parts.map(Number) as [number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** The Live address from the page's meta tag, or null when it is missing or not strictly valid. */
function lanLiveHref(content: string | null | undefined, pageHostname: string): string | null {
  if (typeof content !== 'string') return null
  const match = LIVE_URL.exec(content)
  if (!match) return null
  const [, host, portText] = match as unknown as [string, string, string]
  const port = Number(portText)
  if (!isPrivateIPv4(host) || port < 1024 || port > 65535) return null
  if (host === pageHostname) return null
  // Rebuilt from the parts, never the raw string.
  return `http://${host}:${port}/`
}

export function demoModeSwitch(location: { hostname: string; search: string }, liveMeta?: string | null): ModeSwitch {
  if (!LOOPBACK_HOSTNAMES.includes(location.hostname)) {
    const href = lanLiveHref(liveMeta, location.hostname)
    return href ? { kind: 'link', href } : { kind: 'unavailable', reason: 'not-on-host' }
  }

  const values = new URLSearchParams(location.search).getAll('live')
  const value = values.length === 1 ? values[0]! : ''
  const port = PORT_PARAM.test(value) ? Number(value) : 0
  if (port < 1024 || port > 65535) return { kind: 'unavailable', reason: 'not-running' }
  // 127.0.0.1, not localhost: it is where the Live launch link signed the browser in.
  return { kind: 'link', href: `http://127.0.0.1:${port}/` }
}
