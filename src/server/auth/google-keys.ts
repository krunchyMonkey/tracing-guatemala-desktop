import type { GoogleJwk } from './google-id-token'

// Google signing keys (JWKS) cache (#178). Fails closed: without usable keys
// the caller gets KeysUnavailableError, mapped to 'provider-unavailable'.

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
export const MIN_TTL_MS = 5 * 60_000
export const MAX_TTL_MS = 24 * 60 * 60_000
export const REFETCH_INTERVAL_MS = 60_000
export const FETCH_TIMEOUT_MS = 5_000

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GoogleKeyCache {
  /** Keys for verification. Pass the token's kid so an unknown one can trigger one rate-limited refetch. */
  getKeys(kid?: string): Promise<GoogleJwk[]>
}

export class KeysUnavailableError extends Error {
  constructor() {
    super('provider-unavailable')
  }
}

export function createGoogleKeyCache(
  options: { fetch?: FetchLike; now?: () => number; url?: string } = {}
): GoogleKeyCache {
  const doFetch: FetchLike = options.fetch ?? ((u, i) => fetch(u, i))
  const now = options.now ?? Date.now
  const url = options.url ?? GOOGLE_CERTS_URL
  let keys: GoogleJwk[] = []
  let expiresAt = 0
  let lastFetch = -Infinity
  let inflight: Promise<void> | null = null

  async function refresh(): Promise<void> {
    lastFetch = now()
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) return
      const body = (await res.json()) as { keys?: unknown }
      if (!Array.isArray(body.keys)) return
      const fresh = (body.keys as GoogleJwk[]).filter(
        (k) =>
          k && typeof k === 'object' && k.kty === 'RSA' && typeof k.kid === 'string' && (k.use === undefined || k.use === 'sig')
      )
      if (fresh.length === 0) return
      const match = /max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '')
      const ttl = match ? Number(match[1]) * 1000 : MIN_TTL_MS
      keys = fresh
      expiresAt = now() + Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttl))
    } catch {
      // keep whatever we had
    }
  }

  function refreshOnce(): Promise<void> {
    inflight ??= refresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    async getKeys(kid) {
      const stale = keys.length === 0 || now() >= expiresAt
      const unknownKid = kid !== undefined && !keys.some((k) => k.kid === kid)
      const canRefetch = keys.length === 0 || now() - lastFetch >= REFETCH_INTERVAL_MS
      if ((stale || unknownKid) && canRefetch) await refreshOnce()
      // Expired keys are never served: if the refresh failed, fail closed.
      if (keys.length === 0 || now() >= expiresAt) throw new KeysUnavailableError()
      return keys
    }
  }
}
