import { createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'
import type { IdentityFailure, VerifiedIdentity } from './identity'

// Verifies a Google OpenID Connect ID token (#178). Results carry only a fixed
// reason code, never the token or its claims.

export const MAX_TOKEN_BYTES = 8 * 1024
export const CLOCK_SKEW_SECONDS = 60
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

export interface GoogleJwk extends JsonWebKey {
  kid?: string
}

export interface VerifyOptions {
  clientId: string
  nonce: string
  /** Current time in ms. */
  now: number
  keys: GoogleJwk[]
}

export type VerifyResult = { ok: true; identity: VerifiedIdentity } | { ok: false; reason: IdentityFailure }

const fail = (reason: IdentityFailure): VerifyResult => ({ ok: false, reason })
const B64URL = /^[A-Za-z0-9_-]+$/

function decodePart(part: string): Buffer | null {
  if (!B64URL.test(part)) return null
  return Buffer.from(part, 'base64url')
}

function parseJson(part: string): Record<string, unknown> | null {
  const bytes = decodePart(part)
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function verifyGoogleIdToken(token: string, options: VerifyOptions): VerifyResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) return fail('invalid-token')
  const parts = token.split('.')
  if (parts.length !== 3) return fail('invalid-token')
  const [h, p, s] = parts as [string, string, string]
  const header = parseJson(h)
  const payload = parseJson(p)
  const signature = decodePart(s)
  if (!header || !payload || !signature || signature.length === 0) return fail('invalid-token')
  if (header.alg !== 'RS256') return fail('invalid-token')
  if (typeof header.kid !== 'string' || header.kid.length === 0) return fail('invalid-token')
  const jwk = options.keys.find((k) => k.kid === header.kid && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig'))
  if (!jwk) return fail('bad-signature')

  let valid: boolean
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' })
    valid = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, signature)
  } catch {
    valid = false
  }
  if (!valid) return fail('bad-signature')

  if (typeof payload.iss !== 'string' || !ISSUERS.has(payload.iss)) return fail('wrong-issuer')
  const aud = payload.aud
  const audOk =
    typeof aud === 'string' ? aud === options.clientId : Array.isArray(aud) && aud.length === 1 && aud[0] === options.clientId
  if (!audOk) return fail('wrong-audience')
  if (payload.azp !== undefined && payload.azp !== options.clientId) return fail('wrong-audience')

  const nowSeconds = options.now / 1000
  if (typeof payload.exp !== 'number' || !(payload.exp > nowSeconds - CLOCK_SKEW_SECONDS)) return fail('expired-token')
  if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) return fail('expired-token')

  if (typeof payload.nonce !== 'string' || !sameText(payload.nonce, options.nonce)) return fail('nonce-mismatch')

  const sub = payload.sub
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255) return fail('invalid-token')
  const email = payload.email
  if (typeof email !== 'string' || email.length === 0 || email.length > 320 || payload.email_verified !== true) {
    return fail('unverified-email')
  }
  const lower = email.toLowerCase()
  const hd = payload.hd
  const emailAuthoritative =
    lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com') || (typeof hd === 'string' && hd.length > 0)
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 200) : null
  return {
    ok: true,
    identity: { provider: 'google', subject: sub, email, emailVerified: true, emailAuthoritative, name }
  }
}
