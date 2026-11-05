import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppUser, SignInRequest, UserMutationResult, UserRole } from '../../src/shared/users'
import { createFakeIdentityProvider } from '../../src/server/auth/fake-provider'
import type { VerifiedIdentity } from '../../src/server/auth/identity'
import { authorizeCall, type Principal } from '../../src/server/auth/policy'
import { fakeIdentityAllowed, testFakeProvider } from '../../src/server/auth/provider-selection'
import { createMemoryUserSessionStore, type UserSessionStore } from '../../src/server/auth/user-sessions'
import { initLanTestProfile, LAN_TEST_MARKER } from '../../src/server/lan-profile'
import { CALL_NAMES } from '../../src/server/live-host'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import { call, send, signIn, type Reply, type Signed } from './live-helpers'

// #180: Google per-user sessions on the HTTPS proxy listener (--https-host with --google-client).
// The identity provider is the deterministic fake (no Google, no network). Fictional people only.

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const NAME = 'tg.example.com'
const ORIGIN = `https://${NAME}`
const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }
const clientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}
const caseInput = { title: 'Maternal grandparents', goal: 'Find where my grandmother Rosa was born.', orderReference: 'FO-EXAMPLE-0042', dueDate: '2026-11-15' }
const everything = { clientId: null, archived: 'all', states: [], text: '', sort: 'created' }

const person = (subject: string, email: string, name: string): VerifiedIdentity => ({
  provider: 'google',
  subject,
  email,
  emailVerified: true,
  emailAuthoritative: true,
  name
})
const PEOPLE = {
  'code-ana-9f3': person('sub-ana', 'ana@example.test', 'Ana Fictional'),
  'code-ben-4k1': person('sub-ben', 'ben@example.test', 'Ben Fictional'),
  'code-cy-7m2': person('sub-cy', 'cy@example.test', 'Cy Fictional')
}
const ANA = 'code-ana-9f3'
const BEN = 'code-ben-4k1'
const CY = 'code-cy-7m2'

let root: string
let dataDir: string
let staticDir: string
let logs: string[]
let running: RunningLiveServer | null
let nowMs: number
let sessionSpy: { store: UserSessionStore; deleteAllCalls: number }

function spyStore(inner: UserSessionStore): { store: UserSessionStore; deleteAllCalls: number } {
  const spy = {
    deleteAllCalls: 0,
    store: {
      create: (u, v) => inner.create(u, v),
      find: (id) => inner.find(id),
      touch: (id) => inner.touch(id),
      delete: (id) => inner.delete(id),
      deleteForUser: (u) => inner.deleteForUser(u),
      deleteAll: () => {
        spy.deleteAllCalls++
        inner.deleteAll()
      }
    } as UserSessionStore
  }
  return spy
}

async function start(extra: { googleClientFile?: string | null; withIdentity?: boolean } = {}): Promise<RunningLiveServer> {
  if (!existsSync(join(dataDir, LAN_TEST_MARKER))) initLanTestProfile(dataDir)
  sessionSpy = spyStore(createMemoryUserSessionStore({ now: () => nowMs }))
  let last: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      running = await startLiveServer({
        dataDir,
        port: 0,
        staticDir,
        appInfo,
        httpsHost: NAME,
        ...(extra.googleClientFile !== undefined ? { googleClientFile: extra.googleClientFile } : {}),
        ...(extra.withIdentity === false
          ? {}
          : {
              identity: createFakeIdentityProvider({
                identities: PEOPLE,
                failures: { 'code-down': 'provider-unavailable', 'code-no': 'denied-by-user' }
              })
            }),
        userSessions: sessionSpy.store,
        now: () => new Date(nowMs),
        log: (line) => logs.push(line)
      })
      return running
    } catch (error) {
      last = error
      if (!(error instanceof Error) || !error.message.startsWith('Port ')) throw error
    }
  }
  throw last
}

function viaProxy(live: RunningLiveServer, method: string, path: string, headers: Record<string, string> = {}, body?: string, host = NAME): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: live.port + 2, method, path, agent: false, setHost: false, headers: { Host: host, ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

const form = { 'Content-Type': 'application/x-www-form-urlencoded' }
const json = (headers: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', ...headers })
const setCookies = (reply: Reply): string[] => (reply.headers['set-cookie'] as string[] | undefined) ?? []
/** `name=value` of a non-empty Set-Cookie for `name`, or null. */
const cookieOf = (reply: Reply, name: string): string | null => {
  const found = setCookies(reply).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
  return found ? found.split(';')[0]! : null
}
const SESSION = '__Host-tg_session'
const LOGIN = '__Host-tg_login'
const navigate = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }

async function beginLogin(live: RunningLiveServer): Promise<Reply> {
  const reply = await viaProxy(live, 'POST', '/api/v1/auth/google/start', { Origin: ORIGIN, ...form, 'Sec-Fetch-Site': 'same-origin' }, '')
  expect(reply.status, reply.text).toBe(303)
  return reply
}

/** A whole sign-in attempt: start, then Google's redirect back with `code`. */
async function attempt(
  live: RunningLiveServer,
  code: string,
  extraHeaders: Record<string, string> = {},
  loginCookieOverride?: string | null,
  alsoCookie?: string
): Promise<Reply> {
  const started = await beginLogin(live)
  const login = loginCookieOverride === undefined ? cookieOf(started, LOGIN) : loginCookieOverride
  const cookie = [login, alsoCookie].filter(Boolean).join('; ')
  return viaProxy(live, 'GET', `/api/v1/auth/google/callback?code=${code}&state=s`, { ...(cookie ? { Cookie: cookie } : {}), ...navigate, ...extraHeaders })
}

interface Who extends Signed {
  id: string
}

async function sessionFrom(live: RunningLiveServer, callback: Reply): Promise<Signed> {
  expect(callback.status, callback.text).toBe(303)
  expect(callback.headers['location']).toBe('/')
  const cookie = cookieOf(callback, SESSION)
  expect(cookie).not.toBeNull()
  const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: cookie! })).json() as { authenticated: boolean; csrfToken: string }
  expect(probe.authenticated).toBe(true)
  return { cookie: cookie!, csrf: probe.csrfToken }
}

const pcall = (live: RunningLiveServer, who: Signed, name: string, ...args: unknown[]) =>
  viaProxy(live, 'POST', `/api/v1/call/${name}`, json({ Origin: ORIGIN, Cookie: who.cookie, 'X-TG-CSRF': who.csrf }), JSON.stringify({ args }))
const result = <T>(reply: Reply): T => {
  expect(reply.status, reply.text).toBe(200)
  return (reply.json() as { result: T }).result
}

/** Approve a stranger's sign-in request as the host and return their id. */
async function approve(live: RunningLiveServer, host: Signed, code: string, displayName: string, role: UserRole): Promise<string> {
  const denied = await attempt(live, code)
  expect(denied.headers['location']).toBe('/?signin=not-approved')
  const email = PEOPLE[code as keyof typeof PEOPLE]!.email
  const requests = await call<SignInRequest[]>(live, host, 'listSignInRequests')
  const request = requests.find((r) => r.email === email)
  expect(request).toBeDefined()
  const approved = await call<UserMutationResult>(live, host, 'approveSignInRequest', request!.id, { displayName, role })
  if (!approved.ok) throw new Error('approve failed')
  return approved.user.id
}

interface World {
  live: RunningLiveServer
  host: Signed
  owner: Who
  researcher: Who
}

async function world(): Promise<World> {
  const live = await start()
  const host = await signIn(live)
  const ownerId = await approve(live, host, ANA, 'Ana Fictional', 'owner')
  const researcherId = await approve(live, host, BEN, 'Ben Fictional', 'researcher')
  const owner = { ...(await sessionFrom(live, await attempt(live, ANA))), id: ownerId }
  const researcher = { ...(await sessionFrom(live, await attempt(live, BEN))), id: researcherId }
  return { live, host, owner, researcher }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-google-sessions-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  logs = []
  running = null
  nowMs = Date.parse('2026-06-01T09:00:00Z')
})

afterEach(async () => {
  await running?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('authorization policy table', () => {
  const NEVER = ['createBackup', 'restoreBackup', 'getBackupStatus', 'getLanStatus', 'createPairingCode', 'listDevices', 'revokeDevice', 'revokeAllDevices', 'disableLan']
  const ADMIN = ['listUsers', 'listSignInRequests', 'createUser', 'approveSignInRequest', 'dismissSignInRequest', 'setUserRole', 'setUserStatus', 'revokeUserSessions']
  const SELF = ['getMyAccount', 'revokeMySessions']

  const expected = (name: string, p: Principal): 'allow' | 'host-only' | 'forbidden' => {
    if (p.kind === 'host') return name === 'revokeMySessions' ? 'forbidden' : 'allow'
    if (NEVER.includes(name)) return 'host-only'
    if (p.kind === 'device') return ADMIN.includes(name) ? 'host-only' : SELF.includes(name) ? 'forbidden' : 'allow'
    if (ADMIN.includes(name)) return p.role === 'owner' ? 'allow' : 'forbidden'
    return 'allow'
  }
  const principals: [string, Principal][] = [
    ['host', { kind: 'host' }],
    ['device', { kind: 'device' }],
    ['researcher', { kind: 'user', role: 'researcher' }],
    ['owner', { kind: 'user', role: 'owner' }]
  ]

  it('lists the special calls as real call names', () => {
    for (const name of [...NEVER, ...ADMIN, ...SELF]) expect(CALL_NAMES).toContain(name)
  })

  it.each(principals)('%s: every call name', (_label, principal) => {
    for (const name of CALL_NAMES) {
      const decision = authorizeCall(name, principal)
      const want = expected(name, principal)
      expect(decision.allowed ? 'allow' : decision.code, `${name} for ${_label}`).toBe(want)
    }
  })

  it('never lets a remote principal reach backups, device admin or LAN calls, owner included', () => {
    for (const name of NEVER) {
      expect(authorizeCall(name, { kind: 'user', role: 'owner' }).allowed, name).toBe(false)
      expect(authorizeCall(name, { kind: 'user', role: 'researcher' }).allowed, name).toBe(false)
      expect(authorizeCall(name, { kind: 'device' }).allowed, name).toBe(false)
    }
  })
})

describe('mode selection', () => {
  it('only uses the fake identity provider with both test flags', () => {
    expect(fakeIdentityAllowed({})).toBe(false)
    expect(fakeIdentityAllowed({ TG_TEST_HOOKS: '1' })).toBe(false)
    expect(fakeIdentityAllowed({ TG_TEST_FAKE_IDENTITY: '1' })).toBe(false)
    expect(fakeIdentityAllowed({ TG_TEST_HOOKS: '1', TG_TEST_FAKE_IDENTITY: '0' })).toBe(false)
    expect(testFakeProvider({ TG_TEST_FAKE_IDENTITY: '1' })).toBeNull()
    expect(testFakeProvider({ TG_TEST_HOOKS: '1', TG_TEST_FAKE_IDENTITY: '1' })).not.toBeNull()
  })

  it('refuses --google-client without --https-host and starts nothing', async () => {
    initLanTestProfile(dataDir)
    await expect(startLiveServer({ dataDir, port: 0, staticDir, appInfo, googleClientFile: join(root, 'client.json') })).rejects.toThrow(/--google-client needs --https-host/)
    // The folder lock was released: a plain start works.
    running = await startLiveServer({ dataDir, port: 0, staticDir, appInfo })
  })

  it('refuses a missing or wrong client file with a fixed message and starts nothing', async () => {
    initLanTestProfile(dataDir)
    await expect(startLiveServer({ dataDir, port: 0, staticDir, appInfo, httpsHost: NAME, googleClientFile: join(root, 'missing.json') })).rejects.toThrow(
      /Google client file could not be read\. Nothing was started\./
    )
    const wrong = join(root, 'wrong.json')
    writeFileSync(wrong, JSON.stringify({ web: { client_id: 'fictional.apps.googleusercontent.com', client_secret: 'fictional-secret-value', redirect_uris: ['https://other.example.com/x'] } }))
    const failure = await startLiveServer({ dataDir, port: 0, staticDir, appInfo, httpsHost: NAME, googleClientFile: wrong }).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/redirect URI/)
    expect((failure as Error).message).not.toContain('fictional-secret-value')
    running = await startLiveServer({ dataDir, port: 0, staticDir, appInfo })
  })

  it('starts with a valid client file and redirects to Google without any network', async () => {
    const file = join(root, 'client.json')
    writeFileSync(
      file,
      JSON.stringify({ web: { client_id: 'fictional.apps.googleusercontent.com', client_secret: 'fictional-secret-value', redirect_uris: [`${ORIGIN}/api/v1/auth/google/callback`] } })
    )
    const live = await start({ googleClientFile: file, withIdentity: false })
    const started = await beginLogin(live)
    expect(String(started.headers['location'])).toMatch(/^https:\/\/accounts\.google\.com\//)
    expect(String(started.headers['location'])).not.toContain('fictional-secret-value')
    expect(cookieOf(started, LOGIN)).not.toBeNull()
  })
})

describe('start of sign-in', () => {
  it('redirects to the provider with a Lax login-state cookie', async () => {
    const live = await start()
    const reply = await beginLogin(live)
    expect(String(reply.headers['location'])).toMatch(/^https:\/\/fake\.invalid\/auth\?login=/)
    const raw = setCookies(reply).find((c) => c.startsWith(`${LOGIN}=`))!
    expect(raw).toMatch(/^__Host-tg_login=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/)
    expect(raw).not.toMatch(/Domain=/i)
    expect(reply.headers['cache-control']).toBe('no-store')
  })

  it.each([
    ['the public apex', { Origin: 'https://krunchymonkey.dev' }],
    ['the www host', { Origin: 'https://www.krunchymonkey.dev' }],
    ['plain http', { Origin: `http://${NAME}` }],
    ['no Origin', {}],
    ['same-site fetch metadata', { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-site' }],
    ['cross-site fetch metadata', { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }]
  ])('refuses a start from %s', async (_label, headers) => {
    const live = await start()
    const reply = await viaProxy(live, 'POST', '/api/v1/auth/google/start', { ...form, ...headers }, '')
    expect(reply.status).toBe(403)
    expect(setCookies(reply)).toEqual([])
    expect(reply.headers['location']).toBeUndefined()
  })

  it('refuses a JSON body and a large body', async () => {
    const live = await start()
    expect((await viaProxy(live, 'POST', '/api/v1/auth/google/start', json({ Origin: ORIGIN }), '{}')).status).toBe(415)
    expect((await viaProxy(live, 'POST', '/api/v1/auth/google/start', { Origin: ORIGIN, ...form }, 'x'.repeat(2000))).status).toBe(413)
    expect((await viaProxy(live, 'GET', '/api/v1/auth/google/start')).status).toBe(405)
  })
})

describe('the sign-in callback', () => {
  it('signs an approved owner in with exactly the host-only session cookie', async () => {
    const live = await start()
    const host = await signIn(live)
    await approve(live, host, ANA, 'Ana Fictional', 'owner')
    const reply = await attempt(live, ANA)
    expect(reply.status).toBe(303)
    expect(reply.headers['location']).toBe('/')
    const raw = setCookies(reply).find((c) => c.startsWith(`${SESSION}=`))!
    expect(raw).toMatch(/^__Host-tg_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/)
    expect(raw).not.toMatch(/Domain=/i)
    expect(setCookies(reply).some((c) => c.startsWith(`${LOGIN}=;`) && c.includes('Max-Age=0'))).toBe(true)
    const signed = await sessionFrom(live, reply)
    const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: signed.cookie })).json()
    expect(probe).toEqual({
      authenticated: true,
      csrfToken: signed.csrf,
      remote: true,
      auth: 'google',
      demoUrl: null,
      user: { displayName: 'Ana Fictional', role: 'owner', email: 'ana@example.test' }
    })
  })

  it('records an unknown person as a request only: no session, no user', async () => {
    const live = await start()
    const host = await signIn(live)
    const before = await call<AppUser[]>(live, host, 'listUsers')
    const reply = await attempt(live, CY)
    expect(reply.headers['location']).toBe('/?signin=not-approved')
    expect(cookieOf(reply, SESSION)).toBeNull()
    expect(await call<AppUser[]>(live, host, 'listUsers')).toEqual(before)
    const requests = await call<SignInRequest[]>(live, host, 'listSignInRequests')
    expect(requests.map((r) => r.email)).toEqual(['cy@example.test'])
  })

  it('gives a disabled person no session', async () => {
    const { live, host, researcher } = await world()
    const user = (await call<AppUser[]>(live, host, 'listUsers')).find((u) => u.id === researcher.id)!
    expect(await call(live, host, 'setUserStatus', user.id, 'disabled', user.version)).toMatchObject({ ok: true })
    const reply = await attempt(live, BEN)
    expect(reply.headers['location']).toBe('/?signin=disabled')
    expect(cookieOf(reply, SESSION)).toBeNull()
  })

  it('refuses without the login-state cookie, with a made-up one, and on replay', async () => {
    const live = await start()
    const host = await signIn(live)
    await approve(live, host, ANA, 'Ana Fictional', 'owner')
    for (const login of [null, `${LOGIN}=made-up-value`]) {
      const reply = await attempt(live, ANA, {}, login)
      expect(reply.headers['location'], String(login)).toBe('/?signin=expired')
      expect(cookieOf(reply, SESSION)).toBeNull()
    }
    const started = await beginLogin(live)
    const cookie = cookieOf(started, LOGIN)!
    const url = `/api/v1/auth/google/callback?code=${ANA}&state=s`
    const first = await viaProxy(live, 'GET', url, { Cookie: cookie, ...navigate })
    expect(cookieOf(first, SESSION)).not.toBeNull()
    const replay = await viaProxy(live, 'GET', url, { Cookie: cookie, ...navigate })
    expect(replay.headers['location']).toBe('/?signin=expired')
    expect(cookieOf(replay, SESSION)).toBeNull()
  })

  it('refuses callbacks that are not top-level navigations or are too long', async () => {
    const live = await start()
    for (const headers of ([{ 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Mode': 'no-cors' }, { 'Sec-Fetch-Dest': 'image' }, { 'Sec-Fetch-Dest': 'iframe' }] as Record<string, string>[])) {
      const reply = await attempt(live, ANA, headers)
      expect(reply.status, JSON.stringify(headers)).toBe(403)
      expect(setCookies(reply)).toEqual([])
    }
    const post = await viaProxy(live, 'POST', '/api/v1/auth/google/callback?code=x', { Origin: ORIGIN, ...navigate })
    expect(post.status).toBe(405)
    const long = await viaProxy(live, 'GET', `/api/v1/auth/google/callback?code=${'a'.repeat(5000)}`, navigate)
    expect(long.status).toBe(400)
  })

  it('maps provider outage, cancel and unknown failures without a session', async () => {
    const live = await start()
    expect((await attempt(live, 'code-down')).headers['location']).toBe('/?signin=unavailable')
    expect((await attempt(live, 'code-no')).headers['location']).toBe('/?signin=cancelled')
    expect((await attempt(live, 'code-garbage')).headers['location']).toBe('/?signin=failed')
  })

  it('rotates: signing in again ends the session the browser already held', async () => {
    const { live, owner } = await world()
    const again = await attempt(live, ANA, {}, undefined, owner.cookie)
    const fresh = cookieOf(again, SESSION)
    expect(fresh).not.toBeNull()
    expect(fresh).not.toBe(owner.cookie)
    expect((await pcall(live, owner, 'getMyAccount')).status).toBe(401)
  })
})

describe('what each role may call', () => {
  it('lets a researcher use the shared workspace and refuses the user directory', async () => {
    const { live, researcher } = await world()
    expect((await pcall(live, researcher, 'listClients', listQuery)).status).toBe(200)
    const client = result<{ ok: true; client: { id: string } }>(await pcall(live, researcher, 'createClient', clientInput))
    expect(client.ok).toBe(true)
    expect(result<{ ok: boolean }>(await pcall(live, researcher, 'createCase', client.client.id, caseInput)).ok).toBe(true)
    expect((await pcall(live, researcher, 'listCases', everything)).status).toBe(200)
    for (const name of ['listUsers', 'listSignInRequests', 'createUser', 'approveSignInRequest', 'dismissSignInRequest', 'setUserRole', 'setUserStatus', 'revokeUserSessions']) {
      const reply = await pcall(live, researcher, name)
      expect(reply.status, name).toBe(403)
      expect(reply.json(), name).toEqual({ error: 'forbidden' })
    }
  })

  it('lets an owner manage accounts, recorded under the owner id, and nothing host-only', async () => {
    const { live, owner, researcher } = await world()
    const users = result<AppUser[]>(await pcall(live, owner, 'listUsers'))
    expect(users).toHaveLength(2)
    const ben = users.find((u) => u.id === researcher.id)!
    const changed = result<UserMutationResult>(await pcall(live, owner, 'setUserRole', ben.id, 'owner', ben.version))
    expect(changed).toMatchObject({ ok: true })
    const mine = result<AppUser | null>(await pcall(live, owner, 'getMyAccount'))
    expect(mine).toMatchObject({ id: owner.id, role: 'owner', displayName: 'Ana Fictional' })
    await running!.close()
    running = null
    const db = new DatabaseSync(join(dataDir, 'data', 'tracing-guatemala.sqlite'), { readOnly: true })
    const events = db.prepare("SELECT actor FROM user_events WHERE action = 'role-changed' AND user_id = ?").all(ben.id) as { actor: string }[]
    db.close()
    expect(events).toEqual([{ actor: owner.id }])
  })

  it.each(['createBackup', 'restoreBackup', 'getBackupStatus', 'getLanStatus', 'createPairingCode', 'listDevices', 'revokeDevice', 'revokeAllDevices', 'disableLan'])(
    'refuses %s to both an owner and a researcher',
    async (name) => {
      const { live, owner, researcher } = await world()
      for (const who of [owner, researcher]) {
        const reply = await pcall(live, who, name)
        expect(reply.status, name).toBe(403)
        expect(reply.json()).toEqual({ error: 'host-only' })
      }
    }
  )

  it('refuses backup upload and download, and an unknown call is 404', async () => {
    const { live, owner } = await world()
    const headers = { Origin: ORIGIN, Cookie: owner.cookie, 'X-TG-CSRF': owner.csrf }
    expect((await viaProxy(live, 'POST', '/api/v1/backup/upload', { ...headers, 'Content-Type': 'application/octet-stream' }, 'x')).status).toBe(403)
    expect((await viaProxy(live, 'GET', '/api/v1/backup/download/anything.tgbackup', headers)).status).toBe(403)
    expect((await pcall(live, owner, 'noSuchCall')).status).toBe(404)
    expect((await viaProxy(live, 'GET', '/launch')).status).toBe(404)
  })

  it('getMyAccount is null for the host, revokeMySessions is users only', async () => {
    const { live, host } = await world()
    expect(await call(live, host, 'getMyAccount')).toBeNull()
    const reply = await send(live, 'POST', '/api/v1/call/revokeMySessions', { Origin: live.origin, 'Content-Type': 'application/json', Cookie: host.cookie, 'X-TG-CSRF': host.csrf }, '{"args":[]}')
    expect(reply.status).toBe(403)
  })
})

describe('ending sessions', () => {
  it('applies a role downgrade on the very next request: old session ends, new sign-in has the new role', async () => {
    const { live, host, owner, researcher } = await world()
    // Promote Ben so Ana may be downgraded.
    const users = await call<AppUser[]>(live, host, 'listUsers')
    const ben = users.find((u) => u.id === researcher.id)!
    expect(await call(live, host, 'setUserRole', ben.id, 'owner', ben.version)).toMatchObject({ ok: true })
    const ana = users.find((u) => u.id === owner.id)!
    expect(await call(live, host, 'setUserRole', ana.id, 'researcher', ana.version)).toMatchObject({ ok: true })
    // Role is not kept in the session: the old cookie is rejected (auth version changed).
    expect((await pcall(live, owner, 'listUsers')).status).toBe(401)
    const fresh = await sessionFrom(live, await attempt(live, ANA))
    const denied = await pcall(live, fresh, 'listUsers')
    expect(denied.status).toBe(403)
    expect(denied.json()).toEqual({ error: 'forbidden' })
  })

  it('cuts a disabled user off on the next request', async () => {
    const { live, host, researcher } = await world()
    expect((await pcall(live, researcher, 'listClients', listQuery)).status).toBe(200)
    const ben = (await call<AppUser[]>(live, host, 'listUsers')).find((u) => u.id === researcher.id)!
    await call(live, host, 'setUserStatus', ben.id, 'disabled', ben.version)
    const reply = await pcall(live, researcher, 'listClients', listQuery)
    expect(reply.status).toBe(401)
    expect(reply.json()).toEqual({ error: 'not-signed-in' })
    const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: researcher.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)
  })

  it('lets the host and an owner revoke a user\'s sessions', async () => {
    const { live, host, owner, researcher } = await world()
    expect(await call(live, host, 'revokeUserSessions', researcher.id)).toMatchObject({ ok: true })
    expect((await pcall(live, researcher, 'listClients', listQuery)).status).toBe(401)
    const second = await sessionFrom(live, await attempt(live, BEN))
    expect((await pcall(live, second, 'listClients', listQuery)).status).toBe(200)
    expect(result<UserMutationResult>(await pcall(live, owner, 'revokeUserSessions', researcher.id))).toMatchObject({ ok: true })
    expect((await pcall(live, second, 'listClients', listQuery)).status).toBe(401)
  })

  it('revokeMySessions signs the caller out everywhere and clears the cookie', async () => {
    const { live, researcher } = await world()
    const other = await sessionFrom(live, await attempt(live, BEN))
    const reply = await pcall(live, researcher, 'revokeMySessions')
    expect(reply.status).toBe(200)
    expect(reply.json()).toEqual({ result: { ok: true } })
    expect(setCookies(reply).some((c) => c.startsWith(`${SESSION}=;`) && c.includes('Max-Age=0'))).toBe(true)
    expect((await pcall(live, researcher, 'listClients', listQuery)).status).toBe(401)
    expect((await pcall(live, other, 'listClients', listQuery)).status).toBe(401)
  })

  it('logout needs Origin and CSRF, deletes the session and the reused cookie fails', async () => {
    const { live, researcher } = await world()
    expect((await viaProxy(live, 'POST', '/api/v1/auth/logout', json({ Origin: ORIGIN, Cookie: researcher.cookie }), '{}')).status).toBe(403)
    expect((await viaProxy(live, 'POST', '/api/v1/auth/logout', json({ Cookie: researcher.cookie, 'X-TG-CSRF': researcher.csrf }), '{}')).status).toBe(403)
    const out = await viaProxy(live, 'POST', '/api/v1/auth/logout', json({ Origin: ORIGIN, Cookie: researcher.cookie, 'X-TG-CSRF': researcher.csrf }), '{}')
    expect(out.status).toBe(200)
    expect(setCookies(out).some((c) => c.startsWith(`${SESSION}=;`) && c.includes('Max-Age=0') && c.includes('Secure'))).toBe(true)
    expect((await pcall(live, researcher, 'listClients', listQuery)).status).toBe(401)
  })

  it('expires an idle session and an old session with the injected clock', async () => {
    const { live, researcher } = await world()
    nowMs += 8 * 3_600_000 + 1_000
    expect((await pcall(live, researcher, 'listClients', listQuery)).status).toBe(401)
    // Absolute: kept busy every 7 hours, still gone after 7 days.
    const busy = await sessionFrom(live, await attempt(live, ANA))
    for (let i = 0; i < 24; i++) {
      nowMs += 7 * 3_600_000
      expect((await pcall(live, busy, 'getMyAccount')).status, `step ${i}`).toBe(200)
    }
    nowMs += 7 * 3_600_000
    expect((await pcall(live, busy, 'getMyAccount')).status).toBe(401)
  })

  it('signs everyone out when the host restarts', async () => {
    const { live, researcher } = await world()
    expect((await pcall(live, researcher, 'listClients', listQuery)).status).toBe(200)
    await live.close()
    running = null
    const again = await start()
    const reply = await pcall(again, researcher, 'listClients', listQuery)
    expect(reply.status).toBe(401)
    // The directory survived: signing in again works.
    const fresh = await sessionFrom(again, await attempt(again, BEN))
    expect((await pcall(again, fresh, 'listClients', listQuery)).status).toBe(200)
  })

  it('clears every session when LAN is turned off and when a backup is restored', async () => {
    const { live, host } = await world()
    expect(await call(live, host, 'disableLan')).toEqual({ disabled: true })
    expect(sessionSpy.deleteAllCalls).toBe(1)
    // Restoring is allowed once LAN is off; even a refused restore token path ends in the clear.
    const reply = await send(live, 'POST', '/api/v1/call/restoreBackup', { Origin: live.origin, 'Content-Type': 'application/json', Cookie: host.cookie, 'X-TG-CSRF': host.csrf }, JSON.stringify({ args: [randomUUID()] }))
    expect(reply.status).toBe(200)
    expect(sessionSpy.deleteAllCalls).toBe(2)
  })
})

describe('CSRF, Origin and cookies', () => {
  it('refuses a call without the CSRF token or with a foreign Origin', async () => {
    const { live, researcher } = await world()
    const body = JSON.stringify({ args: [listQuery] })
    expect((await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: ORIGIN, Cookie: researcher.cookie }), body)).status).toBe(403)
    expect((await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: ORIGIN, Cookie: researcher.cookie, 'X-TG-CSRF': 'made-up' }), body)).status).toBe(403)
    for (const origin of ['https://krunchymonkey.dev', 'https://www.krunchymonkey.dev', `http://${NAME}`, `https://${NAME}:8443`]) {
      const reply = await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: origin, Cookie: researcher.cookie, 'X-TG-CSRF': researcher.csrf }), body)
      expect(reply.status, origin).toBe(403)
    }
    const sameSite = await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: ORIGIN, 'Sec-Fetch-Site': 'same-site', Cookie: researcher.cookie, 'X-TG-CSRF': researcher.csrf }), body)
    expect(sameSite.status).toBe(403)
    const noSession = await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: ORIGIN, 'X-TG-CSRF': researcher.csrf }), body)
    expect(noSession.status).toBe(401)
  })

  it('does not let a tossed look-alike cookie change who is signed in', async () => {
    const { live, owner, researcher } = await world()
    const value = (c: string) => c.split('=')[1]!
    const body = JSON.stringify({ args: [] })
    const headers = (cookie: string) => json({ Origin: ORIGIN, Cookie: cookie, 'X-TG-CSRF': researcher.csrf })
    // A non-prefixed name is ignored; the real __Host- cookie is what is read.
    const ignored = await viaProxy(live, 'POST', '/api/v1/call/getMyAccount', headers(`tg_session=${value(owner.cookie)}; ${researcher.cookie}`), body)
    expect(result<AppUser>(ignored).id).toBe(researcher.id)
    // Only the look-alike: nobody.
    const only = await viaProxy(live, 'POST', '/api/v1/call/getMyAccount', headers(`tg_session=${value(researcher.cookie)}`), body)
    expect(only.status).toBe(401)
    // The same name twice (cookie tossing): refused rather than picking one.
    const dup = await viaProxy(live, 'POST', '/api/v1/call/getMyAccount', headers(`${SESSION}=attacker; ${researcher.cookie}`), body)
    expect(dup.status).toBe(401)
  })

  it('has no device pairing: enroll is 404 and a device cookie opens nothing', async () => {
    const { live, host } = await world()
    const enroll = await viaProxy(live, 'POST', '/api/v1/lan/enroll', json({ Origin: ORIGIN }), JSON.stringify({ code: 'AAAA-AAAA' }))
    expect(enroll.status).toBe(404)
    expect(setCookies(enroll)).toEqual([])
    expect((await viaProxy(live, 'POST', '/api/v1/lan/logout', json({ Origin: ORIGIN }), '{}')).status).toBe(404)
    const pairing = await send(live, 'POST', '/api/v1/call/createPairingCode', { Origin: live.origin, 'Content-Type': 'application/json', Cookie: host.cookie, 'X-TG-CSRF': host.csrf }, '{"args":[]}')
    expect(pairing.status).toBe(409)
    const withDevice = await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: ORIGIN, Cookie: `tg_lan_${live.port}=anything`, 'X-TG-CSRF': 'anything' }), JSON.stringify({ args: [listQuery] }))
    expect(withDevice.status).toBe(401)
    // The loopback launch-link session is not accepted on the proxy listener either.
    const asHost = await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: ORIGIN, Cookie: host.cookie, 'X-TG-CSRF': host.csrf }), JSON.stringify({ args: [listQuery] }))
    expect(asHost.status).toBe(401)
    expect((await viaProxy(live, 'GET', `/launch?token=${live.launchUrl.split('token=')[1]}`)).status).toBe(404)
  })

  it('keeps the host operator path on loopback', async () => {
    const { live, host } = await world()
    expect(await call(live, host, 'getLanStatus')).toEqual({ enabled: true, origin: ORIGIN })
    expect(await call<AppUser[]>(live, host, 'listUsers')).toHaveLength(2)
  })
})

describe('logging', () => {
  it('records no codes, emails, names, cookies or tokens', async () => {
    const { live, owner, researcher } = await world()
    await pcall(live, owner, 'listUsers')
    await attempt(live, CY)
    await attempt(live, 'code-down')
    const all = logs.join('\n')
    for (const secret of [ANA, BEN, CY, 'ana@example.test', 'cy@example.test', 'Ana Fictional', owner.cookie.split('=')[1]!, owner.csrf, researcher.cookie.split('=')[1]!, researcher.csrf]) {
      expect(all).not.toContain(secret)
    }
    expect(all).toContain('/api/v1/auth/google/callback')
  })
})

