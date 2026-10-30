import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

// Who may use the Live web host (#110). Layers, all required for data calls:
//  1. Loopback only: the server listens on 127.0.0.1 and accepts only its own
//     Host header, which defeats DNS rebinding.
//  2. Launch link: the host prints a secret link when it starts. Opening it
//     gives the browser an HttpOnly, SameSite=Strict session cookie. Other OS
//     users and other devices never see the link.
//  3. Same origin: writes need an Origin header equal to the host's own origin
//     (and Sec-Fetch-Site same-origin when the browser sends it).
//  4. CSRF token: per session, readable only by same-origin script, sent as a
//     header on every write.
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

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Host headers this host answers to: its loopback address and port only. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`]
}

export function hostIsAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  return typeof host === 'string' && allowedHosts(port).includes(host.toLowerCase())
}

/** For writes: the request comes from a page served by this host. */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  if (origin.toLowerCase() !== `http://${host.toLowerCase()}`) return false
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin'
}

/** For reads such as downloads: refuse anything a browser marks as cross-site or cross-origin. */
export function isNotCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}
