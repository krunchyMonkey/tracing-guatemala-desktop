import type { ModeSwitch } from '../runtime/AppRuntime'

// Where "Back to Live" may point (#114), decided only from the demo page's own
// address: no network, no build-time URL. The Live host and the demo mirror are
// both on the researcher's computer, so the link is offered only when this page
// itself was opened on that computer (loopback) with a valid `?live=<port>`.
// On a LAN address the same page is on someone else's phone or tablet: a link to
// "127.0.0.1" would open that device's own localhost, so none is ever offered.

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1']
const PORT_PARAM = /^[1-9]\d{3,4}$/

export function demoModeSwitch(location: { hostname: string; search: string }): ModeSwitch {
  if (!LOOPBACK_HOSTNAMES.includes(location.hostname)) return { kind: 'unavailable', reason: 'not-on-host' }

  const values = new URLSearchParams(location.search).getAll('live')
  const value = values.length === 1 ? values[0]! : ''
  const port = PORT_PARAM.test(value) ? Number(value) : 0
  if (port < 1024 || port > 65535) return { kind: 'unavailable', reason: 'not-running' }
  // 127.0.0.1, not localhost: it is where the Live launch link signed the browser in.
  return { kind: 'link', href: `http://127.0.0.1:${port}/` }
}
