import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { DATABASE_FILE_NAME } from '../../src/main/database/connection'
import { createFakeIdentityProvider } from '../../src/server/auth/fake-provider'
import type { VerifiedIdentity } from '../../src/server/auth/identity'
import { initLanTestProfile, LAN_TEST_MARKER } from '../../src/server/lan-profile'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { AppUser } from '../../src/shared/users'
import { activeUser } from './helpers/ownership-helpers'
import { send, signIn, writeHeaders, type Reply, type Signed } from './live-helpers'

// #246-a: the session reports what research it reaches (display only), and an Owner researches as
// the same account. Fictional people; the Google provider is the deterministic fake.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const NAME = 'tg.example.com'
const ORIGIN = `https://${NAME}`
const nav = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
const cb = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }

type Key = 'o' | 'p' | 'r'
const identityOf = (key: Key): VerifiedIdentity => ({
  provider: 'google',
  subject: `sub-${key}`,
  email: `sub-${key}@example.test`,
  emailVerified: true,
  emailAuthoritative: false,
  name: `Person ${key.toUpperCase()}`
})
const PEOPLE = Object.fromEntries((['o', 'p', 'r'] as Key[]).map((key) => [`code-${key}`, identityOf(key)]))

let root: string
let dataDir: string
let staticDir: string
let running: RunningLiveServer | null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-research-reach-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  running = null
})

afterEach(async () => {
  await running?.close()
  rmSync(root, { recursive: true, force: true })
})

function viaProxy(live: RunningLiveServer, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: live.port + 2, method, path, agent: false, setHost: false, headers: { Host: NAME, ...headers } }, (res) => {
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

const cookieOf = (reply: Reply, name: string): string | null => {
  const cookies = (reply.headers['set-cookie'] as string[] | undefined) ?? []
  const found = cookies.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
  return found ? found.split(';')[0]! : null
}

async function startServer(mode: 'plain' | 'pairing' | 'google'): Promise<RunningLiveServer> {
  if (!existsSync(join(dataDir, LAN_TEST_MARKER))) initLanTestProfile(dataDir)
  let last: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      running = await startLiveServer({
        dataDir,
        port: 0,
        staticDir,
        appInfo,
        ...(mode === 'google' ? { httpsHost: NAME, identity: createFakeIdentityProvider({ identities: PEOPLE }) } : {}),
        ...(mode === 'pairing' ? { httpsHost: NAME } : {}),
        log: () => undefined
      })
      return running
    } catch (error) {
      last = error
      if (!(error instanceof Error) || !error.message.startsWith('Port ')) throw error
    }
  }
  throw last
}

async function signInAs(live: RunningLiveServer, key: Key): Promise<Signed> {
  const started = await viaProxy(live, 'GET', '/api/v1/auth/google/start', nav)
  const callback = await viaProxy(live, 'GET', `/api/v1/auth/google/callback?code=code-${key}&state=s`, { Cookie: cookieOf(started, '__Host-tg_login')!, ...cb })
  expect(callback.status, callback.text).toBe(303)
  const cookie = cookieOf(callback, '__Host-tg_session')!
  const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: cookie })).json() as { csrfToken: string }
  return { cookie, csrf: probe.csrfToken }
}

const pcall = (live: RunningLiveServer, who: Signed, name: string, ...args: unknown[]) =>
  viaProxy(live, 'POST', `/api/v1/call/${name}`, { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: who.cookie, 'X-TG-CSRF': who.csrf }, JSON.stringify({ args }))
const hostCall = (live: RunningLiveServer, host: Signed, name: string, ...args: unknown[]) =>
  send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, host), JSON.stringify({ args }))
const result = <T>(reply: Reply): T => {
  expect(reply.status, reply.text).toBe(200)
  return (reply.json() as { result: T }).result
}

function withData<T>(work: (data: AppData) => T): T {
  const side = new AppData(dataDir)
  try {
    return work(side)
  } finally {
    side.close()
  }
}

const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }
const clientIn = (displayName: string) => ({ displayName, source: 'direct', sourceDetail: null, fiverrUsername: null, email: null, otherContact: null, preferredContactChannel: 'unspecified' })

const rowCount = () => {
  const db = new DatabaseSync(join(dataDir, 'data', DATABASE_FILE_NAME))
  try {
    return (db.prepare('SELECT count(*) AS n FROM clients').get() as { n: number }).n
  } finally {
    db.close()
  }
}

async function hostSessionResearch(live: RunningLiveServer, host: Signed): Promise<unknown> {
  const reply = await send(live, 'GET', '/api/v1/session', { Cookie: host.cookie })
  expect(reply.status).toBe(200)
  const body = reply.json() as { authenticated: boolean; research?: unknown }
  expect(body.authenticated).toBe(true)
  return body.research
}

describe('session research reach', () => {
  it('is all for a host session on a profile without users, and none once an account exists', async () => {
    initLanTestProfile(dataDir)
    const live = await startServer('plain')
    const host = await signIn(live)
    expect(await hostSessionResearch(live, host)).toBe('all')
    withData((d) => activeUser(d, 'sub-first', 'First Person'))
    expect(await hostSessionResearch(live, host)).toBe('none')
  })

  it('is none for a paired device once the profile has users', async () => {
    initLanTestProfile(dataDir)
    withData((d) => activeUser(d, 'sub-first', 'First Person'))
    const live = await startServer('pairing')
    const host = await signIn(live)
    const { code } = result<{ code: string }>(await hostCall(live, host, 'createPairingCode'))
    const enrolled = await viaProxy(live, 'POST', '/api/v1/lan/enroll', { 'Content-Type': 'application/json', Origin: ORIGIN }, JSON.stringify({ code, deviceName: 'Kitchen tablet' }))
    expect(enrolled.status, enrolled.text).toBe(200)
    const cookie = String(enrolled.headers['set-cookie']?.[0]).split(';')[0]!
    const session = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: cookie })).json() as { authenticated: boolean; research?: unknown }
    expect(session).toMatchObject({ authenticated: true, research: 'none' })
  })

  it('is own for a Google Owner and a Google Researcher', async () => {
    initLanTestProfile(dataDir)
    withData((d) => {
      activeUser(d, 'sub-o', 'Person O', 'owner')
      activeUser(d, 'sub-r', 'Person R', 'researcher')
    })
    const live = await startServer('google')
    for (const key of ['o', 'r'] as const) {
      const who = await signInAs(live, key)
      const session = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: who.cookie })).json() as { research?: unknown }
      expect(session.research, key).toBe('own')
    }
    const host = await signIn(live)
    expect(await hostSessionResearch(live, host)).toBe('none')
  })
})

describe('an Owner researches as the same account', () => {
  async function world() {
    initLanTestProfile(dataDir)
    const users = withData((d) => ({
      o: activeUser(d, 'sub-o', 'Person O', 'owner'),
      p: activeUser(d, 'sub-p', 'Person P', 'owner'),
      r: activeUser(d, 'sub-r', 'Person R', 'researcher')
    }))
    const live = await startServer('google')
    const host = await signIn(live)
    return { live, host, users, o: await signInAs(live, 'o'), p: await signInAs(live, 'p'), r: await signInAs(live, 'r') }
  }

  it('stores the session account as owner (a body naming another owner is refused), and keeps user administration', async () => {
    const w = await world()
    // The request can't name an owner: the strict argument schema refuses the extra field, and nothing is written.
    const clientRows = () => withData((d) => (d.db.prepare('SELECT count(*) AS n FROM clients').get() as { n: number }).n)
    const before = clientRows()
    const named = { ...clientIn('Alfa Client'), ownerUserId: w.users.p.id }
    const refused = await pcall(w.live, w.o, 'createClient', named)
    expect(refused.status).toBe(400)
    expect(clientRows()).toBe(before)
    const made = result<{ ok: boolean; client: { id: string } }>(await pcall(w.live, w.o, 'createClient', clientIn('Alfa Client')))
    expect(made.ok).toBe(true)
    const id = made.client.id
    expect(withData((d) => d.ownership.getClientOwner(id))).toMatchObject({ ownerUserId: w.users.o.id })
    expect(result<{ id: string }[]>(await pcall(w.live, w.o, 'listClients', listQuery)).map((c) => c.id)).toEqual([id])
    expect(result<{ id: string }>(await pcall(w.live, w.o, 'getClient', id)).id).toBe(id)
    expect(result<AppUser[]>(await pcall(w.live, w.o, 'listUsers'))).toHaveLength(3)
  })

  it('hides it from a second Owner and from a Researcher', async () => {
    const w = await world()
    const id = result<{ client: { id: string } }>(await pcall(w.live, w.o, 'createClient', clientIn('Alfa Client'))).client.id
    for (const other of [w.p, w.r]) {
      expect(result<unknown[]>(await pcall(w.live, other, 'listClients', listQuery))).toEqual([])
      expect(result(await pcall(w.live, other, 'getClient', id))).toBeNull()
    }
  })

  it('refuses a host client create with 409 owner-required and writes nothing', async () => {
    const w = await world()
    const before = rowCount()
    const reply = await hostCall(w.live, w.host, 'createClient', clientIn('Host Attempt'))
    expect(reply.status).toBe(409)
    expect(reply.json()).toEqual({ error: 'owner-required' })
    expect(rowCount()).toBe(before)
  })
})
