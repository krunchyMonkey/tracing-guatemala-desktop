import type { IncomingMessage } from 'node:http'

// Cookies of the Google user-session mode (#180). The `__Host-` prefix makes a
// browser accept them only with `Secure`, `Path=/` and no `Domain`, so another
// site (or a sibling subdomain) cannot overwrite or shadow them. No port in the
// name: the HTTPS proxy origin is fixed. The login-state cookie is `Lax` because
// Google's redirect back is a cross-site top-level GET; the session cookie is
// `Strict`.

export const SESSION_COOKIE = '__Host-tg_session'
export const LOGIN_COOKIE = '__Host-tg_login'
export const LOGIN_COOKIE_MAX_AGE_S = 600

export const userSessionCookie = (id: string) => `${SESSION_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict`
export const clearUserSessionCookie = () => `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
export const loginCookie = (id: string) => `${LOGIN_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_COOKIE_MAX_AGE_S}`
export const clearLoginCookie = () => `${LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`

/**
 * The value of a cookie that appears exactly once. A duplicate name (cookie
 * tossing, or a stale copy) is treated as absent instead of picking one.
 */
export function readUniqueCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  let found: string | undefined
  let count = 0
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      count++
      found = part.slice(eq + 1).trim()
    }
  }
  return count === 1 ? found : undefined
}
