import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

// Who may use the Live web host (#110). Layers, all required for data calls:
//  1. Bound address: each listener accepts only its own Host header (the
//     loopback one 127.0.0.1:<port>; the opt-in home-network one, #135, only
//     <its private address>:<port>), which defeats DNS rebinding. The
//     home-network listener never uses steps 2-4: paired devices (#136, see
//     devices.ts) have their own enrollment, session cookie and CSRF token.
//  2. Launch link: the host prints a secret link when it starts. Opening it
//     gives the browser an HttpOnly, SameSite=Strict session cookie. Other OS
//     users and other devices never see the link.
//  3. Same origin: writes need an Origin header equal to the host's own origin
//     (and Sec-Fetch-Site same-origin when the browser sends it).
//  4. CSRF token: per session, readable only by same-origin script, sent as a
//     header on every write.
// Trusted-proxy HTTPS (#167, --https-host): a third kind of listener on
//     127.0.0.1:<port + 2> for a local reverse proxy that terminates TLS. Host must
//     equal the configured bare DNS name, Origin must equal https://<name> and
//     cookies are Secure, all from configuration. `Forwarded`, `X-Forwarded-*` and
//     `X-Real-IP` are never read: the proxy is trusted only because it is what can
//     reach that loopback port. Any local process of the same OS user can reach it
//     too and could send the right Host (see the note below).
// Loopback is not OS-user isolation: any process of the same OS user can read
// the launch link from the terminal. See docs/architecture/web-first-runtime.md.

export const CSRF_HEADER = 'x-tg-csrf'
const MAX_SESSIONS = 20

const newSecret = () => randomBytes(32).toString('base64url')

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface Session {
  id: string
  csrfToken: string
}

export class SessionStore {
  /** Valid while this host runs; restarting the host invalidates it and every session. */
  readonly launchToken = newSecret()
  private readonly sessions = new Map<string, Session>()

  isLaunchToken(candidate: string): boolean {
    return sameSecret(candidate, this.launchToken)
  }

  create(): Session {
    const session = { id: newSecret(), csrfToken: newSecret() }
    this.sessions.set(session.id, session)
    // Keep memory bounded if the launch link is opened many times.
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    return session
  }

  find(id: string | undefined): Session | null {
    if (!id) return null
    for (const session of this.sessions.values()) {
      if (sameSecret(id, session.id)) return session
    }
    return null
  }

  checkCsrf(session: Session, header: string | string[] | undefined): boolean {
    return typeof header === 'string' && sameSecret(header, session.csrfToken)
  }
}

/** Cookies are shared across ports on 127.0.0.1, so the name carries the port. */
export const sessionCookieName = (port: number) => `tg_live_${port}`

export function sessionCookie(port: number, id: string): string {
  return `${sessionCookieName(port)}=${id}; Path=/; HttpOnly; SameSite=Strict`
}

/** Home-network device sessions (#136) use their own cookie name, never the loopback one. */
export const lanCookieName = (port: number) => `tg_lan_${port}`

/** `Secure` is added automatically when the listener's origin is HTTPS. */
export function lanSessionCookie(port: number, id: string, secure: boolean): string {
  return `${lanCookieName(port)}=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

export function lanClearCookie(port: number, secure: boolean): string {
  return `${lanCookieName(port)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * Host headers the loopback listener answers to: 127.0.0.1 and its port only. Not
 * `localhost`: that name is the fictional demo mirror's site (#114), so Live's
 * cookie must never be set there.
 */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`]
}

/** Host headers the opt-in home-network listener answers to (#135): its own address and port, nothing else. */
export function lanAllowedHosts(address: string, port: number): string[] {
  return [`${address}:${port}`]
}

export function hostIsAllowed(req: IncomingMessage, hosts: readonly string[]): boolean {
  const host = req.headers.host
  return typeof host === 'string' && hosts.includes(host.toLowerCase())
}

/**
 * For writes: the request comes from a page served by this listener. `origin` is
 * the listener's own configured origin (scheme included, so HTTPS can follow),
 * never something reflected from the request.
 */
export function isSameOriginRequest(req: IncomingMessage, origin: string): boolean {
  const claimed = req.headers.origin
  if (typeof claimed !== 'string' || claimed.toLowerCase() !== origin.toLowerCase()) return false
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin'
}

/** For reads such as downloads: refuse anything a browser marks as cross-site or cross-origin. */
export function isNotCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}
