import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeIdentityProvider } from '../../src/server/auth/fake-provider'
import { readGoogleClientFile } from '../../src/server/auth/google-config'
import { verifyGoogleIdToken, type GoogleJwk } from '../../src/server/auth/google-id-token'
import { createGoogleKeyCache, MAX_TTL_MS, MIN_TTL_MS, REFETCH_INTERVAL_MS } from '../../src/server/auth/google-keys'
import { createGoogleProvider, LOGIN_TTL_MS, MAX_BEGINS, MAX_FAILURES, MAX_PENDING } from '../../src/server/auth/google-provider'
import { signIn, type AccountGate, type VerifiedIdentity } from '../../src/server/auth/identity'

const CLIENT_ID = 'fake-client-123.apps.googleusercontent.com'
const SECRET = 'GOCSPX-fictional-secret-value'
const REDIRECT = 'https://tg.example.test/api/v1/auth/google/callback'
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const sec = NOW / 1000

function makeKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } as GoogleJwk
  return { jwk, privateKey }
}

const main = makeKey('k1')
const other = makeKey('k1') // same kid, different key material

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

function sign(
  claims: Record<string, unknown>,
  opts: { key?: KeyObject; header?: Record<string, unknown> } = {}
): string {
  const header = opts.header ?? { alg: 'RS256', kid: 'k1', typ: 'JWT' }
  const body = `${b64(header)}.${b64(claims)}`
  const sig = createSign('RSA-SHA256').update(body).sign(opts.key ?? main.privateKey).toString('base64url')
  return `${body}.${sig}`
}

const baseClaims = (extra: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  azp: CLIENT_ID,
  sub: 'sub-1001',
  email: 'ana.fictional@gmail.com',
  email_verified: true,
  name: 'Ana Ficticia',
  nonce: 'n-1',
  iat: sec - 10,
  exp: sec + 3000,
  ...extra
})

const verify = (token: string, over: Partial<{ nonce: string; keys: GoogleJwk[]; now: number }> = {}) =>
  verifyGoogleIdToken(token, { clientId: CLIENT_ID, nonce: 'n-1', now: NOW, keys: [main.jwk], ...over })

describe('verifyGoogleIdToken', () => {
  it('accepts a valid token', () => {
    const r = verify(sign(baseClaims()))
    expect(r).toEqual({
      ok: true,
      identity: {
        provider: 'google',
        subject: 'sub-1001',
        email: 'ana.fictional@gmail.com',
        emailVerified: true,
        emailAuthoritative: true,
        name: 'Ana Ficticia'
      }
    })
  })

  it('accepts the bare issuer and a one-element aud array', () => {
    expect(verify(sign(baseClaims({ iss: 'accounts.google.com', aud: [CLIENT_ID] }))).ok).toBe(true)
  })

  it.each([
    ['wrong audience', { aud: 'other.apps.googleusercontent.com' }, 'wrong-audience'],
    ['array aud with extras', { aud: [CLIENT_ID, 'x'] }, 'wrong-audience'],
    ['wrong azp', { azp: 'x' }, 'wrong-audience'],
    ['wrong issuer', { iss: 'https://evil.example' }, 'wrong-issuer'],
    ['expired', { exp: sec - 61 }, 'expired-token'],
    ['future iat', { iat: sec + 61 }, 'expired-token'],
    ['nonce mismatch', { nonce: 'n-2' }, 'nonce-mismatch'],
    ['missing nonce', { nonce: undefined }, 'nonce-mismatch'],
    ['email_verified false', { email_verified: false }, 'unverified-email'],
    ['email_verified missing', { email_verified: undefined }, 'unverified-email'],
    ['email_verified string', { email_verified: 'true' }, 'unverified-email'],
    ['empty sub', { sub: '' }, 'invalid-token'],
    ['long sub', { sub: 'a'.repeat(256) }, 'invalid-token']
  ])('rejects %s', (_n, extra, reason) => {
    expect(verify(sign(baseClaims(extra)))).toEqual({ ok: false, reason })
  })

  it('tolerates 60 seconds of clock skew', () => {
    expect(verify(sign(baseClaims({ exp: sec - 59, iat: sec + 59 }))).ok).toBe(true)
  })

  it('treats non-Gmail without hd as non-authoritative, with hd as authoritative', () => {
    const plain = verify(sign(baseClaims({ email: 'ana@example.test' })))
    expect(plain.ok && plain.identity.emailAuthoritative).toBe(false)
    const ws = verify(sign(baseClaims({ email: 'ana@example.test', hd: 'example.test' })))
    expect(ws.ok && ws.identity.emailAuthoritative).toBe(true)
    const gm = verify(sign(baseClaims({ email: 'ana@googlemail.com' })))
    expect(gm.ok && gm.identity.emailAuthoritative).toBe(true)
  })

  it('rejects a token signed with another key', () => {
    expect(verify(sign(baseClaims(), { key: other.privateKey }))).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects an unknown kid and a tampered payload', () => {
    expect(verify(sign(baseClaims(), { header: { alg: 'RS256', kid: 'zzz' } })).ok).toBe(false)
    const [h, , s] = sign(baseClaims()).split('.')
    const forged = `${h}.${b64(baseClaims({ sub: 'sub-evil' }))}.${s}`
    expect(verify(forged)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects alg none and HS256', () => {
    const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(baseClaims())}.`
    expect(verify(none).ok).toBe(false)
    const hs = sign(baseClaims(), { header: { alg: 'HS256', kid: 'k1' } })
    expect(verify(hs)).toEqual({ ok: false, reason: 'invalid-token' })
    expect(verify(sign(baseClaims(), { header: { alg: 'none', kid: 'k1' } })).ok).toBe(false)
  })

  it('rejects malformed tokens', () => {
    expect(verify('a.b').ok).toBe(false)
    expect(verify('a.b.c.d').ok).toBe(false)
    expect(verify('!!!.???.***').ok).toBe(false)
    expect(verify('').ok).toBe(false)
    expect(verify('a'.repeat(9000)).ok).toBe(false)
    expect(verify(`${b64('not json')}.${b64(baseClaims())}.AAAA`).ok).toBe(false)
  })
})

function jwksResponse(keys: GoogleJwk[], cacheControl?: string, status = 200) {
  return new Response(JSON.stringify({ keys }), {
    status,
    headers: cacheControl ? { 'cache-control': cacheControl } : {}
  })
}

describe('google key cache', () => {
  it('caches within max-age and refetches after', async () => {
    let t = NOW
    const fetch = vi.fn(async () => jwksResponse([main.jwk], 'public, max-age=3600'))
    const cache = createGoogleKeyCache({ fetch, now: () => t })
    await cache.getKeys('k1')
    t += 3_599_000
    await cache.getKeys('k1')
    expect(fetch).toHaveBeenCalledTimes(1)
    t += 2000
    await cache.getKeys('k1')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('floors and caps max-age', async () => {
    let t = NOW
    const fetch = vi.fn(async () => jwksResponse([main.jwk], 'max-age=1'))
    const cache = createGoogleKeyCache({ fetch, now: () => t })
    await cache.getKeys('k1')
    t += MIN_TTL_MS - 1000
    await cache.getKeys('k1')
    expect(fetch).toHaveBeenCalledTimes(1)

    t = NOW
    const big = vi.fn(async () => jwksResponse([main.jwk], 'max-age=99999999'))
    const cache2 = createGoogleKeyCache({ fetch: big, now: () => t })
    await cache2.getKeys('k1')
    t += MAX_TTL_MS + 1000
    await cache2.getKeys('k1')
    expect(big).toHaveBeenCalledTimes(2)
  })

  it('refetches once on unknown kid, rate limited to once a minute', async () => {
    let t = NOW
    const fetch = vi.fn(async () => jwksResponse([main.jwk], 'max-age=3600'))
    const cache = createGoogleKeyCache({ fetch, now: () => t })
    await cache.getKeys('k1')
    await cache.getKeys('nope')
    await cache.getKeys('nope')
    expect(fetch).toHaveBeenCalledTimes(1) // first fetch was < 1 minute ago
    t += REFETCH_INTERVAL_MS
    await cache.getKeys('nope')
    expect(fetch).toHaveBeenCalledTimes(2)
    await cache.getKeys('nope')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('ignores non-RSA and non-sig keys', async () => {
    const ec = { kty: 'EC', kid: 'e1', crv: 'P-256', x: 'a', y: 'b' } as GoogleJwk
    const enc = { ...main.jwk, kid: 'enc', use: 'enc' } as GoogleJwk
    const cache = createGoogleKeyCache({ fetch: async () => jwksResponse([ec, enc, main.jwk]), now: () => NOW })
    expect((await cache.getKeys()).map((k) => k.kid)).toEqual(['k1'])
  })

  it('fails closed on outage, bad status and bad body', async () => {
    const down = createGoogleKeyCache({ fetch: async () => Promise.reject(new Error('boom')), now: () => NOW })
    await expect(down.getKeys('k1')).rejects.toThrow('provider-unavailable')
    const s500 = createGoogleKeyCache({ fetch: async () => jwksResponse([], undefined, 500), now: () => NOW })
    await expect(s500.getKeys()).rejects.toThrow('provider-unavailable')
    const junk = createGoogleKeyCache({ fetch: async () => new Response('nope'), now: () => NOW })
    await expect(junk.getKeys()).rejects.toThrow('provider-unavailable')
  })
})

interface Flow {
  provider: ReturnType<typeof createGoogleProvider>
  calls: { url: string; body: URLSearchParams }[]
  clock: { t: number }
  respond: { current: (nonce: string) => Response | Promise<Response> }
}

function setup(tokenResponse?: (claimsNonce: string) => Response | Promise<Response>): Flow {
  const clock = { t: NOW }
  const calls: Flow['calls'] = []
  const respond = {
    current:
      tokenResponse ??
      ((nonce: string) =>
        new Response(JSON.stringify({ id_token: sign(baseClaims({ nonce })), access_token: 'ya29.fictional-access' }), {
          status: 200
        }))
  }
  let lastNonce = ''
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) return jwksResponse([main.jwk], 'max-age=3600')
    calls.push({ url, body: new URLSearchParams(String(init?.body)) })
    return respond.current(lastNonce)
  }
  const provider = createGoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    fetch,
    now: () => clock.t
  })
  const begin = provider.beginSignIn.bind(provider)
  provider.beginSignIn = () => {
    const r = begin()
    lastNonce = new URL(r.redirectUrl).searchParams.get('nonce') ?? ''
    return r
  }
  return { provider, calls, clock, respond }
}

const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? ''
const cb = (state: string, extra: Record<string, string> = { code: 'code-1' }) => new URLSearchParams({ state, ...extra })

describe('google provider: begin', () => {
  it('builds the exact authorization URL', () => {
    const { provider } = setup()
    const { redirectUrl, loginId } = provider.beginSignIn()
    const u = new URL(redirectUrl)
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = u.searchParams
    expect(q.get('client_id')).toBe(CLIENT_ID)
    expect(q.get('redirect_uri')).toBe(REDIRECT)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('openid email profile')
    expect(redirectUrl).toContain('scope=openid%20email%20profile')
    expect(q.get('prompt')).toBe('select_account')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.has('access_type')).toBe(false)
    expect(q.has('include_granted_scopes')).toBe(false)
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(32)
    expect(q.get('nonce')!.length).toBeGreaterThanOrEqual(32)
    expect(loginId.length).toBeGreaterThanOrEqual(32)
    expect(redirectUrl).not.toContain(SECRET)
  })

  it('rate limits begins and bounds pending logins', () => {
    const { provider } = setup()
    for (let i = 0; i < MAX_BEGINS; i++) provider.beginSignIn()
    expect(() => provider.beginSignIn()).toThrow('too-many-attempts')
    expect(MAX_PENDING).toBe(50)
  })

  it('evicts the oldest pending login beyond the cap', async () => {
    const { provider, clock } = setup()
    const first = provider.beginSignIn()
    const ids: string[] = []
    for (let i = 0; i < MAX_PENDING; i++) {
      clock.t += 5000 // stay under the begin rate limit
      ids.push(provider.beginSignIn().loginId)
    }
    const r = await provider.completeSignIn(first.loginId, cb(stateOf(first.redirectUrl)))
    expect(r).toEqual({ ok: false, reason: 'expired-login' })
  })
})

describe('google provider: complete', () => {
  it('completes the happy path with PKCE and the client secret, exposing only identity', async () => {
    const { provider, calls } = setup()
    const { redirectUrl, loginId } = provider.beginSignIn()
    const r = await provider.completeSignIn(loginId, cb(stateOf(redirectUrl)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.identity).sort()).toEqual(
      ['email', 'emailAuthoritative', 'emailVerified', 'name', 'provider', 'subject'].sort()
    )
    expect(JSON.stringify(r)).not.toMatch(/ya29|id_token|access_token|code-1/)
    expect(calls).toHaveLength(1)
    const { url, body } = calls[0]!
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-1')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('client_secret')).toBe(SECRET)
    expect(body.get('redirect_uri')).toBe(REDIRECT)
    const verifier = body.get('code_verifier')!
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    expect(new URL(redirectUrl).searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url')
    )
  })

  it('rejects a state mismatch and a replayed loginId', async () => {
    const { provider } = setup()
    const a = provider.beginSignIn()
    expect(await provider.completeSignIn(a.loginId, cb('wrong'))).toEqual({ ok: false, reason: 'state-mismatch' })
    // consumed even though it failed
    expect(await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl)))).toEqual({
      ok: false,
      reason: 'expired-login'
    })
    const b = provider.beginSignIn()
    expect((await provider.completeSignIn(b.loginId, cb(stateOf(b.redirectUrl)))).ok).toBe(true)
    expect(await provider.completeSignIn(b.loginId, cb(stateOf(b.redirectUrl)))).toEqual({
      ok: false,
      reason: 'expired-login'
    })
  })

  it('handles missing or unknown loginId and expired logins', async () => {
    const { provider, clock } = setup()
    expect(await provider.completeSignIn(undefined, cb('x'))).toEqual({ ok: false, reason: 'expired-login' })
    expect(await provider.completeSignIn('nope', cb('x'))).toEqual({ ok: false, reason: 'expired-login' })
    const a = provider.beginSignIn()
    clock.t += LOGIN_TTL_MS + 1
    expect(await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl)))).toEqual({
      ok: false,
      reason: 'expired-login'
    })
  })

  it('maps error=access_denied, missing and oversized code', async () => {
    const { provider, calls } = setup()
    const a = provider.beginSignIn()
    expect(await provider.completeSignIn(a.loginId, new URLSearchParams({ error: 'access_denied' }))).toEqual({
      ok: false,
      reason: 'denied-by-user'
    })
    const b = provider.beginSignIn()
    expect(await provider.completeSignIn(b.loginId, new URLSearchParams({ state: stateOf(b.redirectUrl) }))).toEqual({
      ok: false,
      reason: 'invalid-request'
    })
    const c = provider.beginSignIn()
    expect(await provider.completeSignIn(c.loginId, cb(stateOf(c.redirectUrl), { code: 'x'.repeat(2049) }))).toEqual({
      ok: false,
      reason: 'invalid-request'
    })
    expect(calls).toHaveLength(0)
  })

  it('maps token endpoint 400 to invalid-token and 500 or network errors to provider-unavailable', async () => {
    for (const [respond, reason] of [
      [() => new Response('{}', { status: 400 }), 'invalid-token'],
      [() => new Response('{}', { status: 503 }), 'provider-unavailable'],
      [() => Promise.reject(new Error('net down')), 'provider-unavailable'],
      [() => new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }), 'invalid-token']
    ] as const) {
      const { provider, respond: r } = setup()
      r.current = respond
      const a = provider.beginSignIn()
      expect(await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl)))).toEqual({ ok: false, reason })
    }
  })

  it('rejects an id_token with a wrong nonce or audience', async () => {
    const { provider, respond } = setup()
    respond.current = () => new Response(JSON.stringify({ id_token: sign(baseClaims({ nonce: 'other' })) }))
    const a = provider.beginSignIn()
    expect(await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl)))).toEqual({
      ok: false,
      reason: 'nonce-mismatch'
    })
  })

  it('returns provider-unavailable when keys cannot be fetched', async () => {
    const provider = createGoogleProvider({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      now: () => NOW,
      fetch: async (url) => {
        if (url.includes('certs')) throw new Error('down')
        return new Response(JSON.stringify({ id_token: sign(baseClaims()) }))
      }
    })
    const a = provider.beginSignIn()
    expect(await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl)))).toEqual({
      ok: false,
      reason: 'provider-unavailable'
    })
  })

  it('limits failed completions of real logins', async () => {
    const { provider } = setup()
    for (let i = 0; i < MAX_FAILURES; i++) {
      const login = provider.beginSignIn()
      expect(await provider.completeSignIn(login.loginId, cb('wrong-state'))).toEqual({ ok: false, reason: 'state-mismatch' })
    }
    const a = provider.beginSignIn()
    expect(await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl)))).toEqual({
      ok: false,
      reason: 'too-many-attempts'
    })
  })

  it('does not let bogus callbacks without a live login lock everyone out', async () => {
    const { provider } = setup()
    for (let i = 0; i < MAX_FAILURES * 3; i++) {
      expect(await provider.completeSignIn('nope', cb('x'))).toEqual({ ok: false, reason: 'expired-login' })
    }
    const a = provider.beginSignIn()
    expect(await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl)))).toMatchObject({ ok: true })
  })
})

describe('account gate', () => {
  const identity: VerifiedIdentity = {
    provider: 'google',
    subject: 's1',
    email: 'ana.fictional@gmail.com',
    emailVerified: true,
    emailAuthoritative: true,
    name: null
  }
  const provider = () => createFakeIdentityProvider({ identities: { ok: identity }, failures: { bad: 'bad-signature' } })
  const run = async (gate: AccountGate, code = 'ok') => {
    const p = provider()
    const { loginId } = p.beginSignIn()
    return signIn(p, gate, loginId, new URLSearchParams({ code }))
  }

  it('allows only an active account', async () => {
    expect(await run(() => ({ allowed: true, userId: 'u1' }))).toEqual({ ok: true, identity, userId: 'u1' })
    for (const account of ['unknown', 'pending', 'disabled'] as const) {
      expect(await run(() => ({ allowed: false, reason: account }))).toMatchObject({
        ok: false,
        reason: 'account-denied',
        account
      })
    }
  })

  it('does not consult the gate when verification fails', async () => {
    const gate = vi.fn<AccountGate>()
    expect(await run(gate, 'bad')).toEqual({ ok: false, reason: 'bad-signature' })
    expect(gate).not.toHaveBeenCalled()
  })

  it('fake provider is single use per loginId', async () => {
    const p = provider()
    const { loginId } = p.beginSignIn()
    expect((await p.completeSignIn(loginId, new URLSearchParams({ code: 'ok' }))).ok).toBe(true)
    expect(await p.completeSignIn(loginId, new URLSearchParams({ code: 'ok' }))).toEqual({
      ok: false,
      reason: 'expired-login'
    })
  })
})

describe('readGoogleClientFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-google-'))
  const write = (name: string, content: string) => {
    const p = join(dir, name)
    writeFileSync(p, content)
    return p
  }
  const web = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: SECRET, redirect_uris: [REDIRECT], ...over } })

  it('reads a valid web client and derives the redirect URI', () => {
    expect(readGoogleClientFile(write('ok.json', web()), 'tg.example.test')).toEqual({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      redirectUri: REDIRECT
    })
  })

  it('rejects bad files without leaking the secret', () => {
    const cases = [
      write('installed.json', JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: SECRET } })),
      write('badid.json', web({ client_id: 'plain-id' })),
      write('nosecret.json', web({ client_secret: '' })),
      write('nouri.json', web({ redirect_uris: ['https://other.example.test/cb'] })),
      write('json.json', `{"web": ${SECRET}`),
      join(dir, 'missing.json')
    ]
    for (const file of cases) {
      let message = ''
      try {
        readGoogleClientFile(file, 'tg.example.test')
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain(SECRET)
      expect(message).not.toContain(CLIENT_ID)
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('no secrets in console output', () => {
  it('never logs tokens, codes or the client secret during failures', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m))
    const token = sign(baseClaims({ nonce: 'wrong' }))
    verify(token)
    const { provider, respond } = setup()
    respond.current = () => new Response(JSON.stringify({ id_token: token, access_token: 'ya29.leak' }))
    const a = provider.beginSignIn()
    await provider.completeSignIn(a.loginId, cb(stateOf(a.redirectUrl), { code: 'code-leak' }))
    respond.current = () => Promise.reject(new Error(`network ${SECRET}`))
    const b = provider.beginSignIn()
    await provider.completeSignIn(b.loginId, cb(stateOf(b.redirectUrl), { code: 'code-leak' }))
    const output = spies.flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c)).join('\n')
    for (const needle of [token, SECRET, 'code-leak', 'ya29.leak']) expect(output).not.toContain(needle)
    spies.forEach((s) => s.mockRestore())
  })
})
