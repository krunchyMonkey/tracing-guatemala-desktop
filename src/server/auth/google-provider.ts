import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CompleteResult, IdentityFailure, IdentityProvider } from './identity'
import { verifyGoogleIdToken } from './google-id-token'
import { createGoogleKeyCache, type FetchLike, type GoogleKeyCache } from './google-keys'

// Google OIDC authorization code + PKCE, server side, confidential client
// (#178). Pending logins live in memory only. Nothing secret is logged or
// returned; the access token from the token endpoint is discarded.

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const LOGIN_TTL_MS = 10 * 60_000
export const MAX_PENDING = 50
export const BEGIN_WINDOW_MS = 60_000
export const MAX_BEGINS = 30
export const FAIL_WINDOW_MS = 10 * 60_000
export const MAX_FAILURES = 20
export const MAX_CODE_LENGTH = 2048
const TOKEN_TIMEOUT_MS = 10_000
const MAX_STATE_LENGTH = 512

interface Pending {
  state: string
  nonce: string
  verifier: string
  expiresAt: number
}

export interface GoogleProviderOptions {
  clientId: string
  clientSecret: string
  redirectUri: string
  fetch?: FetchLike
  now?: () => number
  keys?: GoogleKeyCache
}

const rand = (bytes: number) => randomBytes(bytes).toString('base64url')

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function readKid(token: string): string | undefined {
  try {
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as { kid?: unknown }
    return typeof header.kid === 'string' ? header.kid : undefined
  } catch {
    return undefined
  }
}

export function createGoogleProvider(options: GoogleProviderOptions): IdentityProvider {
  const doFetch: FetchLike = options.fetch ?? ((u, i) => fetch(u, i))
  const now = options.now ?? Date.now
  const keys = options.keys ?? createGoogleKeyCache({ fetch: doFetch, now })
  const pending = new Map<string, Pending>()
  let begins: number[] = []
  let failures: number[] = []

  const recent = (list: number[], window: number) => list.filter((t) => now() - t < window)

  /** A failed completion of a real pending login: counted toward the limiter. Outages are not counted. */
  function failed(reason: IdentityFailure): CompleteResult {
    failures.push(now())
    return { ok: false, reason }
  }

  return {
    id: 'google',

    beginSignIn() {
      begins = recent(begins, BEGIN_WINDOW_MS)
      if (begins.length >= MAX_BEGINS) throw new Error('too-many-attempts')
      begins.push(now())
      for (const [id, p] of pending) if (p.expiresAt <= now()) pending.delete(id)
      const loginId = rand(32)
      const state = rand(32)
      const nonce = rand(32)
      const verifier = rand(48) // 64 characters
      pending.set(loginId, { state, nonce, verifier, expiresAt: now() + LOGIN_TTL_MS })
      while (pending.size > MAX_PENDING) {
        const oldest = pending.keys().next().value
        if (oldest === undefined) break
        pending.delete(oldest)
      }
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const query = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account'
      })
      return { redirectUrl: `${AUTH_URL}?${query.toString().replace(/\+/g, '%20')}`, loginId }
    },

    async completeSignIn(loginId, params) {
      failures = recent(failures, FAIL_WINDOW_MS)
      if (failures.length >= MAX_FAILURES) return { ok: false, reason: 'too-many-attempts' }

      const login = loginId ? pending.get(loginId) : undefined
      if (loginId) pending.delete(loginId) // single use
      // Not counted: a callback without a live login costs nothing, and counting it would let
      // anyone on the network lock everyone out with bogus requests.
      if (!login || login.expiresAt <= now()) return { ok: false, reason: 'expired-login' }

      if (params.has('error')) return failed('denied-by-user')
      const state = params.get('state')
      if (!state || state.length > MAX_STATE_LENGTH || !same(state, login.state)) return failed('state-mismatch')
      const code = params.get('code')
      if (!code || code.length > MAX_CODE_LENGTH) return failed('invalid-request')

      let idToken: unknown
      try {
        const res = await doFetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            code,
            client_id: options.clientId,
            client_secret: options.clientSecret,
            redirect_uri: options.redirectUri,
            grant_type: 'authorization_code',
            code_verifier: login.verifier
          }).toString(),
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
        })
        if (res.status >= 500) return { ok: false, reason: 'provider-unavailable' }
        if (!res.ok) return failed('invalid-token')
        const body = (await res.json()) as { id_token?: unknown }
        idToken = body.id_token // access_token is deliberately never read
      } catch {
        return { ok: false, reason: 'provider-unavailable' }
      }
      if (typeof idToken !== 'string') return failed('invalid-token')

      let jwks
      try {
        jwks = await keys.getKeys(readKid(idToken))
      } catch {
        return { ok: false, reason: 'provider-unavailable' }
      }
      const result = verifyGoogleIdToken(idToken, {
        clientId: options.clientId,
        nonce: login.nonce,
        now: now(),
        keys: jwks
      })
      if (!result.ok) return failed(result.reason)
      return { ok: true, identity: result.identity }
    }
  }
}
